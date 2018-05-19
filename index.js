#!/usr/bin/env node
/*!
 * XCGI
 * Copyright (c) 2017-2018 Ivan Dustin Bilon
 * GNU AGPLv3 Licensed
 */
var os = require('os')
var http = require('http')
var https = require('https')
var serveStatic = require('serve-static')
var querystring = require('querystring')
var spawn = require('child_process').spawn
var execFileSync = require('child_process').execFileSync
var fs = require('fs')
var path = require('path')
var multiparty = require('multiparty')
var EventEmitter = require('events').EventEmitter
/// HELP MESSAGE ////////////////
function PRINTHELP() {
    var msg = [
        'xcgi <options...> <sites path>',
        'Options:',
        '    -p <port>   Specify different port number. You have to choose',
        '                either http or https only. Default is 80 and 443.',
        '    -h          Http only.',
        '    -s          Https only.',
        '    -r          Redirect http to https. Off by default.',
        '    -m <int>    Max instances of spawned process.',
        '    --shell <>  Set the default shell to be used. Default is bash.'
    ]
    for(var i=0;i<msg.length;i++)
        console.log(msg[i])
}
/////////////////////////////////
var SITES_PATH = '.'
var PORT = 80
var QUEUE = []
var INSTANCE_COUNT = 0
var PGIDS = {}
// IN WINDOWS, WE CAN KILL PGID (USING KILL PROGRAM) WITHOUT
// DETACHING THE PROCESS. IN UNIX, WE NEED TO DETACH THE PROCESS
// SO THAT WE CAN KILL PGID USING `process.kill(-pgid)` FUNCTION.
var DETACH_PROCESS = process.platform == 'win32' ? false : true
/// CONFIGURE ///////////////////
var CONFIG = {
    http: true,
    https: true,
    redirect: false,
    httpsOption: {
        key: '',
        cert: ''
    },
    maxInstances: os.cpus().length * 16,
    shell: 'bash'
}
getopt(process.argv.splice(2), function(option, value) {
    switch(option) {
        case 'p':
            PORT = parseInt(value)
            return true
        case 'h':
            CONFIG.http = true
            CONFIG.https = false
            return false
        case 's':
            CONFIG.http = false
            CONFIG.https = true
            return false
        case 'r':
            CONFIG.http = true
            CONFIG.https = true
            CONFIG.redirect = true
            return false
        case 'm':
            CONFIG.maxInstances = parseInt(value)
            return true
        case 'shell':
            CONFIG.shell = value
            return true
        case 'help':
            PRINTHELP()
            process.exit(0)
            return false
        default:
            if (SITES_PATH == '.')
                SITES_PATH = value
            return false
    }
})
if (CONFIG.https) {
    var key = process.env['XCGI_HTTPS_KEY']
    var cert = process.env['XCGI_HTTPS_CERT']
    if (fs.existsSync(key) && fs.existsSync(cert)) {
        CONFIG.httpsOption.key = fs.readFileSync(key)
        CONFIG.httpsOption.cert = fs.readFileSync(cert)
    } else {
        if (CONFIG.http) {
            console.error('WARNING:', 'XCGI_HTTPS_KEY or XCGI_HTTPS_CERT is not configured. Turning HTTPS off instead.')
            CONFIG.https = false
        } else {
            console.error('ERROR:', 'XCGI_HTTPS_KEY or XCGI_HTTPS_CERT is not configured.')
            process.exit(1)
        }
    }
}
/////////////////////////////////
// console.log(SITES_PATH, PORT)
// console.log(CONFIG)
// process.exit(0)
/////////////////////////////////
var SHELL = CONFIG.shell
var ROOTS = null
var ROOTDIR_DELIMITER = '_'
var ASSET_TYPES = [
    // DOCUMENTS
    '.htm',
    '.html',
    '.txt',
    '.js',
    '.json',
    '.pdf',
    '.css',
    '.csv',
    '.tsv',
    // IMAGES
    '.jpg',
    '.png',
    '.gif',
    '.svg',
    '.ico',
    // AUDO VIDEO
    '.wav',
    '.webm',
    '.ogg',
    '.mp3',
    '.mp4',
    '.mpeg',
    // FONTS
    '.eot',
    '.otf',
    '.ttf',
    '.woff',
    '.woff2',
    '.sfnt',
    // MISC
    '.map'
]
var DEFAULT_SCRIPT = 'default.sh'
var SCRIPT_STATUS_CODES = [200, 400, 404]
/////////////////////////////////
var KillProcess     = GetProcessKiller()
var KillProcessSync = GetProcessKiller(true)
/////////////////////////////////
function Root() {
    this.dir        = null
    this.domain     = null
    this.namespace  = null
    this.emitter    = new EventEmitter()
    this.serveStatic = null
}
/////////////////////////////////
function EnvValue(env, prefix, name, a) {
    name = name.toUpperCase()
    var hasBrackets = name.length > 2 && name.substr(-2) == '[]' ? true : false
    if (hasBrackets)
        name = name.substr(0, name.length-2)
    if (hasBrackets && !Array.isArray(a)) {
        env[prefix + name] = encodeURI(a)
    } else if (Array.isArray(a)) {
        if (a.length == 0)
            return
        if (hasBrackets) {
            var values = []
            for(var i=0;i<a.length;i++)
                values.push(encodeURI(a[i]))
            env[prefix + name] = values.join(' ')
        } else {
            env[prefix + name] = a[0]
        }
    } else {
        env[prefix + name] = a
    }
}
function CreateEnv(req, url, qs, objects, rootdir) {
    var env = {}
    ////////////////////////////////////
    env['REQUEST_URL'] = url
    for(var key in qs)
        EnvValue(env, 'QUERY_', key, qs[key])
    ////////////////////////////////////
    env['REQUEST_METHOD'] = req.method
    ////////////////////////////////////
    env['HTTP_VERSION'] = req.httpVersion
    for(var key in req.headers)
        env['HTTP_' + key.replace(/-/g, '_').toUpperCase()] = req.headers[key]
    ////////////////////////////////////
    env['DOCUMENT_ROOT'] = rootdir
    ////////////////////////////////////
    for(var i=0; i<objects.length;i++) {
        env['QUERY_' + objects[i][0].toUpperCase() + '_ID'] = objects[i][1] || ''
    }
    if (objects.length > 0)
        env['QUERY_ID'] = objects[objects.length-1][1] || ''
    ////////////////////////////////////
    env['STATUS_OK']            = 0
    env['STATUS_BADREQUEST']    = 1
    env['STATUS_NOTFOUND']      = 2
    ////////////////////////////////////
    // INHERITS FROM PROCESS.ENV
    env['PATH'] = process.env['PATH']
    ////////////////////////////////////
    return env
}
function ConsumeQueue() {
    if (INSTANCE_COUNT < CONFIG.maxInstances && QUEUE.length > 0) {
        // console.log('PULL', INSTANCE_COUNT, QUEUE.length)
        var exec = QUEUE.shift()
        setTimeout(exec, 0) // SCHEDULE EXECUTION TO AVOID NESTED FUNCTION CALLS
    }
}
function ExecuteFile(req, res, path, filename, env) {
    if (INSTANCE_COUNT >= CONFIG.maxInstances) {
        QUEUE.push(ExecuteFile.bind(this, req, res, path, filename, env))
        // console.log('DEFER', INSTANCE_COUNT, QUEUE.length)
        return
    }
    INSTANCE_COUNT++ // INCREMENT ON ACCEPT
    // console.log('ACCEPTED', INSTANCE_COUNT, QUEUE.length)
    var buffer      = []
    var infertype   = false
    var proc        = null
    try {
        proc = spawn(SHELL, [filename], {
            cwd: path,
            env: env,
            detached: DETACH_PROCESS
        })
    } catch(e) {
        console.log('SPAWN ERROR:', e.message)
        req.destroy()
        return false
    }
    ///////////////////////////////////////////
    // SAVE PROCESS ID SINCE WE DETACHED IT. MARK IT AS RUNNING = 1.
    // KILL MARKED AS DEAD = 0 UPON PROCESS'S EXIT EVENT.
    // DO NOT APPLY -PID WHEN SAVING TO OBJECT SINCE NEGATIVE VALUE IS SLOW.
    PGIDS[proc.pid] = 1
    ///////////////////////////////////////////
    proc.stdout.on('data', function(data) {
        if (!res.finished) {
            // AUTOMATICALLY INFER CONTENT TYPE
            if (!infertype) {
                if (data[0] == '{'.charCodeAt(0) || data[0] == '['.charCodeAt(0))
                    res.setHeader('Content-Type', 'application/json; charset=utf-8')
                else if (data[0] == '<'.charCodeAt(0))
                    res.setHeader('Content-Type', 'text/html; charset=utf-8')
                else
                    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
                infertype = true
            }
            buffer.push(data) // BUFFER THE DATA
        }
    })
    proc.stderr.on('data', function(error) {
        console.error('STDERR PATH:', path, filename)
        console.error('STDERR MSG:', error.toString())
    })
    proc.on('error', function(err) {
        console.error('PROCESS ERROR:', err)
    })
    proc.on('exit', function(code, signal) {
        /////////////////////////////
        INSTANCE_COUNT--
        ConsumeQueue()
        // INVALIDATE PGID //////////
        PGIDS[proc.pid] = 0
        /////////////////////////////
        if (code != null && code < 256 && code >= 0 && !signal) {
            if (SCRIPT_STATUS_CODES.length > code)
                res.statusCode = SCRIPT_STATUS_CODES[code]
            else {
                res.statusCode = 500
                console.warn('WARNING:', 'A process status code is invalid. StatusCode=' + code)
            }
            res.setHeader('Access-Control-Allow-Origin', '*') // ALLOW CORS ONLY FOR RESOURCE
            res.end(Buffer.concat(buffer))
        } else {
            req.destroy()
            // console.error('ERROR:', 'A process possibly died. Request is destroyed.')
        }
    })
    req.on('error', function() {
        // console.error('REQUEST ERROR:', 'Script will be terminated.')
        KillProcess(-proc.pid)
    })
    req.on('aborted', function() {
        // console.error('REQUEST ABORTED:', 'Script will be terminated.')
        KillProcess(-proc.pid)
    })
}
function GetRoots(path, cb) {
    var roots = []
    fs.readdir(path, function(err, files) {
        if (err)
            throw err
        files.sort(function(a, b) { return b.length - a.length })
        files.sort(function(a, b) {
            if (a[0] == '_')
                return -1
            return 1
        })
        for(var i=0; i<files.length; i++) {
            var a = files[i].split(ROOTDIR_DELIMITER)
            var root = new Root()
            root.dir = files[i]
            root.domain = a.shift()
            root.namespace = '/' + a.join('/')
            root.serveStatic = serveStatic(SITES_PATH + '/' + root.dir)
            roots.push(root)
        }
        cb(roots)
    })
}
function FindRoot(host, url, roots) {
    for(var i=0; i<roots.length; i++) {
        if ((roots[i].domain == '' || host.indexOf(roots[i].domain) != -1)
            && url.indexOf(roots[i].namespace) == 0)
            return roots[i]
    }
    return false
}
function GetRealUrl(url, root) {
    var idx = url.indexOf('?')
    if (idx !== -1)
        url = url.substr(0, idx)
    if (root.namespace.length > 1) {
        var u = url.substring(root.namespace.length)
        if (u[0] != '/')
            u = '/' + u
        return u
    }
    return url
}
function GetObjects(url) {
    var a = url.split('/')
    var objects = []
    var c = 0
    for(var i=0; i<a.length; i++) {
        if (a[i] == '')
            continue
        if (c % 2 == 0)
            objects.push([a[i]])
        else
            objects[objects.length-1].push(a[i])
        c++
    }
    return objects
}
function GetFileName(method, objects) {
    var file = false
    if (method == 'GET')
        if (objects.length > 0 && objects[objects.length-1].length > 1)
            file = 'show.sh'
        else
            file = 'index.sh'
    else if (method == 'POST')
        file = 'create.sh'
    else if (method == 'PUT')
        file = 'update.sh'
    else if (method == 'DELETE')
        file = 'destroy.sh'
    return file
}
function NotFound(res) {
    if (res.finished)
        return
    res.statusCode = 404
    res.end('404 Not Found')
}
function IsAsset(url) {
    var e = url.substr(-5)
    for(var i=0;i<ASSET_TYPES.length;i++)
        if (e.indexOf(ASSET_TYPES[i]) != -1)
            return true
    return false
}
function IsMultipart(req) {
    if (req.headers['content-type'] &&
        req.headers['content-type'].indexOf('multipart/form-data') === 0 &&
        req.method == 'POST')
        return true
    return false
}
function HandleMultipart(req, res, env, exec) {
    var form        = new multiparty.Form();
    form.parse(req, function(err, fields, files) {
        if (err)
            return NotFound(res)
        for(var field in fields)
            EnvValue(env, '_POST_', field, fields[field])
        for(var file in files) {
            var values = []
            for(var i=0; i<files[file].length; i++) {
                if (files[file][i].size == 0)
                    continue
                values.push(files[file][i].path)
            }
            EnvValue(env, '_FILES_', file, values)
        }
        exec()
    })
}
function IsFormUrlEncoded(req) {
    if (req.headers['content-type'] &&
        req.headers['content-type'].indexOf('application/x-www-form-urlencoded') === 0 &&
        req.method == 'POST')
        return true
    return false
}
function HandleFormUrlEncoded(req, env, exec) {
    var data = ''
    req.on('data', function(buffer) {
        data += buffer.toString()
    })
    req.on('end', function() {
        var obj = querystring.parse(data)
        for(var field in obj)
            EnvValue(env, '_POST_', field, obj[field])
        exec()
    })
}
// ChooseExecutable - check if the requested resource/script exists. If not,
//  check if the default handler/script is present. If not, return false.
// cb(err:bool, path, filename)
function ChooseExecutable(filepath, filename, rootpath, cb) {
    fs.exists(filepath + '/' + filename, function(exists) {
        if (exists)
            return cb(false, filepath, filename)
        fs.exists(rootpath + '/' + DEFAULT_SCRIPT, function(exists) {
            if (exists)
                return cb(false, rootpath, DEFAULT_SCRIPT)
            return cb(true)
        })
    })
}
/////////////////////////////////
var SERVER_HANDLER = function(req, res) {
    // req.on('data', function(data) {
    //  console.log(data.toString())
    // })
    // console.log(req.url)
    // console.log(req.method)
    // console.log(req.headers)
    // console.log(req.rawTrailers)
    // console.log(req.httpVersion)
    // var env = createEnv(req)
    // createProcess(res, env)
    // res.end('404 not found')
    // return
    //////////////////////////////////////////
    res.setHeader('X-Powered-By', 'XCGI')
    //////////////////////////////////////////
    req.on('error', function(err) {
        console.log('REQUEST ERROR:', err)
    })
    //////////////////////////////////////////
    // HANDLE CORS
    if (req.method === 'OPTIONS') {
        var headers = {}
        // IE8 does not allow domains to be specified, just the *
        // headers["Access-Control-Allow-Origin"] = req.headers.origin;
        headers["Access-Control-Allow-Origin"] = "*"
        headers["Access-Control-Allow-Methods"] = "POST, GET, PUT, DELETE, OPTIONS"
        headers["Access-Control-Allow-Credentials"] = false
        headers["Access-Control-Max-Age"] = '86400' // 24 hours
        headers["Access-Control-Allow-Headers"] = "X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept"
        res.writeHead(200, headers)
        return res.end()
    }
    //////////////////////////////////////////
    var root        = FindRoot(req.headers.host, req.url, ROOTS)
    if (!root)
        return NotFound(res)
    var realurl     = GetRealUrl(req.url, root)
    if (IsAsset(realurl)) {
        // MODIFY URL TO BE THE REAL URL SO THAT SERVE STATIC CAN WORK CORRECTLY.
        req.url = realurl
        return root.serveStatic(req, res, function(err) {
            if (!err)
                return NotFound(res)
            res.end()
        })
    }
    var a           = req.url.split('?')
    var url         = a[0]
    var qs          = querystring.parse(a[1])
    var objects     = GetObjects(realurl)
    var env         = CreateEnv(req, url, qs, objects, SITES_PATH + '/' + root.dir)
    var objectname  = objects.length > 0 ? objects[objects.length-1][0] : ''
    var rootpath    = path.join(SITES_PATH, root.dir)
    var filename    = GetFileName(req.method, objects)
    var filepath    = path.join(rootpath, objectname)
    ChooseExecutable(filepath, filename, rootpath, function(err, path, filename) {
        if (err)
            return NotFound(res)
        var waitEventName = qs['_wait']
        //////////////////////////////////////
        var f = function() {
            if (waitEventName)
                root.emitter.removeListener(waitEventName, f)
            //////////////////////////////////
            var exec = ExecuteFile.bind(this, req, res, path, filename, env)
            if (IsMultipart(req))
                HandleMultipart(req, res, env, exec)
            else if (IsFormUrlEncoded(req))
                HandleFormUrlEncoded(req, env, exec)
            else
                exec()
        }
        // IMPLEMENT _wait /////
        if (waitEventName) {
            root.emitter.on(waitEventName.substr(0,22), f)
            req.on('close', function() {
                root.emitter.removeListener(waitEventName, f)
            })
        } else {
            f()
        }
    })
    // IMPLEMENT _notify ///////
    res.on('finish', function() {
        if (~['POST', 'PUT', 'DELETE'].indexOf(req.method) &&
            res.statusCode >= 200 && res.statusCode < 300 && qs['_notify'])
            root.emitter.emit(qs['_notify'].substr(0,22))
    })
    //////////////////////////////////////////
    // console.log(root)
    // console.log(realurl)
    // console.log(objects)
    // console.log(objectname)
    // console.log(filename)
}
var SERVER_HANDLER_REDIRECT = function(req, res) {
    req.on('error', function(err) {
        console.log('REDIRECT REQUEST ERROR:', err)
    })
    res.statusCode = 302
    res.setHeader('Location', 'https://' + req.headers.host + req.url)
    res.end('302 Moved')
}
var IS_GREET = false
var IS_GETROOTS = false
var LISTEN_HANDLER = function(port) {
    return function() {
        if (! IS_GETROOTS) {
            GetRoots(SITES_PATH, function(roots) {
                ROOTS = roots
                for(var i=0; i<roots.length; i++)
                    console.log('Site found:', roots[i].dir)
            })
            IS_GETROOTS = true
        }
        if (! IS_GREET) {
            console.log('Welcome to XCGI!')
            console.log('Sites path at', SITES_PATH)
            console.log('Max instances is', CONFIG.maxInstances)
            console.log('Shell used is', SHELL)
            IS_GREET = true
        }
        console.log('Online at port', port)
    }
}
// MAIN ///////////////////////////////
if (CONFIG.http && ! CONFIG.redirect) {
    http.createServer(SERVER_HANDLER).listen(PORT, LISTEN_HANDLER(PORT))
}
if (CONFIG.http && CONFIG.redirect) {
    http.createServer(SERVER_HANDLER_REDIRECT).listen(PORT, LISTEN_HANDLER(PORT))
}
if (CONFIG.https) {
    var port = PORT == 80 ? 443 : PORT
    https.createServer(CONFIG.httpsOption, SERVER_HANDLER).listen(port, LISTEN_HANDLER(port))
}
fs.watch(SITES_PATH, function(type, filename) {
    console.log('Reloading sites...')
    GetRoots(SITES_PATH, function(roots) {
        ROOTS = roots
        for(var i=0; i<roots.length; i++)
            console.log('Site found:', roots[i].dir)
    })
})
// CLEANUP ////////////////////////////
process.on('SIGTERM', process.exit)
process.on('SIGINT', process.exit)
process.on('SIGHUP', process.exit)
process.on('exit', function() {
    try {
        // KILL ALL SPAWNED PROCESS
        for(var pgid in PGIDS)
            if (PGIDS[pgid] == 1)
                KillProcessSync(-pgid)
    } catch(e) {}
})
// HELPERS/UTILITIES //////////////////
function getopt(argv, handle) {
    for(var i=0; i<argv.length; i++) {
        var arg = argv[i]
        var opt = '', value = ''
        if (!arg) return
        if (arg[0] == '-' && arg.length == 2) {
            opt = arg[1]
            value = argv[i+1]
        } else if (arg.substring(0, 2) == '--') {
            opt = arg.substring(2)
            value = argv[i+1]
        } else {
            opt = null
            value = arg
        }
        var hasValue = handle(opt, value)
        if (hasValue) i++ // skip the next argument
    }
}
function KillProcessWin32(pid) {
    spawn('kill', ['--', pid])
}
function KillProcessSyncWin32(pid) {
    execFileSync('kill', ['--', pid])
}
function GetProcessKiller(sync) {
    if (process.platform == 'win32')
        if (sync)
            return KillProcessSyncWin32
        else
            return KillProcessWin32
    return process.kill
}
