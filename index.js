#!/usr/bin/env node
/*!
 * XCGI
 * Copyright (c) 2017-2018 Ivan Dustin Bilon
 * GNU AGPLv3 Licensed
 */
var package         = require('./package.json')
var os              = require('os')
var http            = require('http')
var https           = require('https')
var serveStatic     = require('serve-static')
var querystring     = require('querystring')
var spawn           = require('child_process').spawn
var execFileSync    = require('child_process').execFileSync
var fs              = require('fs')
var path            = require('path')
var formidable      = require('formidable')
var EventEmitter    = require('events').EventEmitter
/// HELP MESSAGE ////////////////
function printHelp() {
    var msg = [
        'xcgi <options...> <sites path>',
        'Options:',
        '    -p <http port>:<https port>',
        '                             Specify different HTTP/HTTPS port number.',
        '    -h                       HTTP only. Turn off HTTPS.',
        '    -s                       HTTPS only. Turn off HTTP.',
        '    -r                       Redirect http to https. Off by default.',
        '    -m <int>                 Max instances of spawned process.',
        '    --shell <>               Set the default shell to be used. Default is bash.',
        '    --max-fields-size <int>  Max size of all fields in a Form. In megabytes.',
        '                             Default is 128.',
        '    --max-file-size <int>    Max file size in file uploads. In megabytes.',
        '                             Default is 256.',
        '    -V                       Print version.'
    ]
    for(var i=0;i<msg.length;i++)
        console.log(msg[i])
}
/////////////////////////////////
var sites_path      = '.'
var http_port       = 80
var https_port      = 443
var queue           = []
var instance_count  = 0
/// CONFIGURE ///////////////////
var config = {
    http: true,
    https: true,
    redirect: false,
    httpsOption: {
        key: '',
        cert: ''
    },
    maxInstances: os.cpus().length * 16,
    shell: 'bash',
    maxFieldsSize: 128,
    maxFileSize: 256
}
getopt(process.argv.splice(2), function(option, value) {
    switch(option) {
        case 'p':
            var ports  = value.split(':')
            http_port  = ports[0] ? parseInt(ports[0]) : http_port
            https_port = ports[1] ? parseInt(ports[1]) : https_port
            return true
        case 'h':
            config.http = true
            config.https = false
            return false
        case 's':
            config.http = false
            config.https = true
            return false
        case 'r':
            config.http = true
            config.https = true
            config.redirect = true
            return false
        case 'm':
            config.maxInstances = parseInt(value)
            return true
        case 'shell':
            config.shell = value
            return true
        case 'max-fields-size':
            config.maxFieldsSize = parseInt(value)
            return true
        case 'max-file-size':
            config.maxFileSize = parseInt(value)
            return true
        case 'help':
            printHelp()
            process.exit(0)
            return false
        case 'V':
            console.log('%s %s', package.name, package.version)
            console.log('Copyright (C) 2017 Free Software Foundation, Inc. <http://fsf.org/>')
            console.log('License %s', package.license)
            console.log('This is free software: you are free to change and redistribute it.')
            console.log('There is NO WARRANTY, to the extent permitted by law.')
            console.log('')
            console.log('Designed and written by %s.', package.author.name)
            console.log('Grace and peace to you from our Lord Jesus Christ.')
            process.exit(0)
            return false
        default:
            if (sites_path == '.')
                sites_path = value
            return false
    }
})
if (config.https) {
    var key = process.env['XCGI_HTTPS_KEY']
    var cert = process.env['XCGI_HTTPS_CERT']
    if (fs.existsSync(key) && fs.existsSync(cert)) {
        config.httpsOption.key = fs.readFileSync(key)
        config.httpsOption.cert = fs.readFileSync(cert)
    } else {
        if (config.http) {
            console.error('WARNING:', 'XCGI_HTTPS_KEY or XCGI_HTTPS_CERT is not configured. Turning HTTPS off instead.')
            config.https = false
        } else {
            console.error('ERROR:', 'XCGI_HTTPS_KEY or XCGI_HTTPS_CERT is not configured.')
            process.exit(1)
        }
    }
}
/////////////////////////////////
var shell               = config.shell
var roots               = []
var rootdir_delimiter   = '_'
var default_script      = 'default.sh'
var script_status_codes = [200, 400, 404, 201, 204, 304, 403, 409, 401]
/////////////////////////////////
function Root() {
    this.dir            = null
    this.domain         = null
    this.namespace      = null
    this.emitter        = new EventEmitter
    this.serveStatic    = null
    this.objectCount    = 0
    this.lastnotify     = {}
    this.lastwait       = {}
}
/////////////////////////////////
function envValue(env, prefix, name, value) {
    name = name.toUpperCase()
    if (Array.isArray(value))
        env[prefix + name] = value.join('\t')
    else
        env[prefix + name] = value
}
function createEnv(req, url, qs, objects, rootdir) {
    var env = Object.assign({}, process.env)
    ////////////////////////////////////
    env['REQUEST_URL'] = url
    for(var key in qs)
        envValue(env, 'QUERY_', key, qs[key])
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
    env['STATUS_CREATED']       = 3
    env['STATUS_NOCONTENT']     = 4
    env['STATUS_NOTMODIFIED']   = 5
    env['STATUS_FORBIDDEN']     = 6
    env['STATUS_CONFLICT']      = 7
    env['STATUS_UNAUTHORIZED']  = 8
    return env
}
function consumeQueue() {
    if (instance_count < config.maxInstances && queue.length > 0) {
        var exec = queue.shift()
        setTimeout(exec, 0) // SCHEDULE EXECUTION TO AVOID NESTED FUNCTION CALLS
    }
}
function executeFile(req, res, path, filename, env) {
    if (instance_count >= config.maxInstances) {
        queue.push(executeFile.bind(this, req, res, path, filename, env))
        return
    }
    instance_count++ // INCREMENT ON ACCEPT
    var buffer      = []
    var infertype   = false
    var proc        = null
    try {
        proc = spawn(shell, [filename], {
            cwd: path,
            env: env
        })
    } catch(e) {
        console.error('SPAWN ERROR %s %s: %s', path, filename, e.message)
        req.destroy()
        return false
    }
    ///////////////////////////////////////////
    // THIS FLUSH FUNCTION SENDS THE DATA WHEN
    // CALLED TWICE. THIS IS CALLED WHEN PROCESS
    // STDOUT IS ENDED, AND WHEN PROCESS EXITS.
    // THIS IS BECAUSE A PROCESS MAY EXIT BUT STDOUT
    // IS NOT YET ENDED.
    var flush_count = 0
    var flush = function() {
        if (++flush_count >= 2)
            res.end(Buffer.concat(buffer))
    }
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
    proc.stdout.on('end', function() {
        flush()
    })
    proc.stderr.on('data', function(data) {
        console.error('STDERR %s %s: %s', path, filename, data.toString())
    })
    proc.on('error', function(error) {
        console.error('PROCESS ERROR %s %s: %s', path, filename, error.message)
    })
    proc.on('exit', function(code, signal) {
        /////////////////////////////
        instance_count--
        consumeQueue()
        /////////////////////////////
        if (code != null && code < 256 && code >= 0 && !signal) {
            if (script_status_codes.length > code)
                res.statusCode = script_status_codes[code]
            else {
                res.statusCode = 500
                console.warn('WARNING:', 'A process status code is invalid. StatusCode=' + code)
            }
            res.setHeader('Access-Control-Allow-Origin', '*') // ALLOW CORS ONLY FOR RESOURCE
            flush()
        } else {
            req.destroy()
        }
    })
    req.on('aborted', function() {
        console.error('REQUEST ABORTED %s %s', path, filename)
    })
}
function sortRoots(roots) {
    return roots.sort(function(a, b) {
        return b.objectCount - a.objectCount
    })
}
function updateRoots(filepath, roots, cb) {
    var newRoots = []
    fs.readdir(filepath, function(err, files) {
        if (err)
            throw err
        for(var i=0; i<files.length; i++) {
            var root = roots.find(function(root) { return root.dir == files[i] })
            if (!root) {
                root                = new Root()
                var a               = files[i].split(rootdir_delimiter)
                root.dir            = files[i]
                root.domain         = a.shift()
                root.namespace      = '/' + a.join('/')
                root.serveStatic    = serveStatic(path.join(sites_path, root.dir), { redirect: false })
                root.objectCount    = (root.dir == "_") ? 0 : root.dir.split("_").length
                newRoots.push(root)
                roots.push(root)
            }
        }
        cb(sortRoots(roots), newRoots)
    })
}
function findRoot(host, url, roots) {
    for(var i=0; i<roots.length; i++) {
        if ((roots[i].domain == '' || host.indexOf(roots[i].domain) != -1)
            && url.indexOf(roots[i].namespace) == 0)
            return roots[i]
    }
    return false
}
function rootIndexOf(root, roots) {
    for(var i=0;i<roots.length;i++)
        if (roots[i].dir == root.dir)
            return i
    return -1
}
function getRealUrl(url, root) {
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
function getObjects(url) {
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
function getFilename(method, objects) {
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
function notFound(res) {
    if (res.finished)
        return
    res.statusCode = 404
    res.end('404 Not Found')
}
function newFormidable() {
    var form            = new formidable.IncomingForm()
    form.multiples      = true
    form.maxFieldsSize  = config.maxFieldsSize * 1024 * 1024
    form.maxFileSize    = config.maxFileSize * 1024 * 1024
    return form
}
function handleForm(req, res, env, exec) {
    var form = newFormidable()
    form.on('error', function(error) {
        notFound(res)
    })
    form.parse(req, function(err, fields, files) {
        if (err)
            return notFound(res)
        for(var field in fields) {
            envValue(env, '_POST_', field, fields[field])
        }
        if (files) {
            for(var field in files) {
                var file = files[field]
                var values = []
                if (Array.isArray(file)) {
                    for (var i=0; i<file.length; i++) {
                        values.push(file[i].path)
                    }
                } else {
                    values.push(file.path)
                }
                envValue(env, '_FILES_', field, values)
            }
        }
        exec()
    })
}
// createNotifyId concatenates REST objects
// but the last ID is omitted. This is particularly
// used as an index in lastnotify dictionary. This uses
// the fast string concatenation in ECMAScript.
function createNotifyId(objects) {
    var id = ''
    for(var i=0;i<objects.length-1;i++)
        id += objects[i][0] + objects[i][1]
    id += objects[objects.length-1][0]
    return id
}
/////////////////////////////////
var server_handler = function(req, res) {
    {
        // LOG REQUEST INFORMATION TO STDOUT
        var url = req.url
        var start = new Date()
        console.log('%s %s %s', start.toLocaleString(), req.method, url)
        res.on('finish', function() {
            var end = new Date()
            var duration = end - start
            console.log('%s %s %s %s %sms', start.toLocaleString(), req.method, url, res.statusCode, duration)
        })
    }
    //////////////////////////////////////////
    req.on('error', function(error) {
        console.error('REQUEST ERROR: %s', error.message)
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
    var root        = findRoot(req.headers.host, req.url, roots)
    if (!root)
        return notFound(res)
    var realurl     = getRealUrl(req.url, root)
    var a           = req.url.split('?')
    var url         = a[0]
    var qs          = querystring.parse(a[1])
    var objects     = getObjects(realurl)
    var env         = createEnv(req, url, qs, objects, sites_path + '/' + root.dir)
    var objectname  = objects.length > 0 ? objects[objects.length-1][0] : ''
    var rootpath    = path.join(sites_path, root.dir)
    var filename    = getFilename(req.method, objects)
    var filepath    = path.join(rootpath, objectname)

    req.on('no static', function() {
        fs.exists(path.join(filepath, filename), function(exists) {
            if (exists)
                executeAPI(filepath, filename)
            else
                req.emit('no api')
        })
    })

    req.on('no api', function() {
        fs.exists(path.join(rootpath, default_script), function(exists) {
            if (exists)
                executeAPI(rootpath, default_script)
            else
                notFound(res)
        })
    })

    // MODIFY URL TO BE THE REAL URL SO THAT SERVE STATIC CAN WORK CORRECTLY.
    req.url = realurl
    root.serveStatic(req, res, function() {
        req.emit('no static')
    })

    function executeAPI(path, filename) {
        var waitid   = qs['_wait'] ? qs['_wait'].substr(0,22) : null
        var notifyid = (waitid || req.method != 'GET') ? createNotifyId(objects) : null
        //////////////////////////////////////
        var f = function() {
            if (waitid) {
                root.emitter.removeListener(notifyid, f)
                root.lastwait[waitid] = new Date
            }
            //////////////////////////////////
            var exec = executeFile.bind(this, req, res, path, filename, env)
            if (req.method == 'GET')
                exec()
            else
                handleForm(req, res, env, exec)
        }
        // IMPLEMENT _wait /////
        if (waitid && req.method == 'GET') {
            if (root.lastnotify[notifyid] === undefined)
                root.lastnotify[notifyid] = 0
            ///////////////////////
            var lastnotify  = root.lastnotify[notifyid]
            var lastwait    = root.lastwait[waitid]
            if (lastwait && (lastnotify === 0 || lastwait >= lastnotify)) {
                root.emitter.on(notifyid, f)
                req.on('close', function() {
                    root.emitter.removeListener(notifyid, f)
                })
            } else {
                f()
            }
        } else {
            f()
        }
        ///////////////////////
        res.on('finish', function() {
            if (root.lastnotify[notifyid] !== undefined &&
                req.method != 'GET' &&
                res.statusCode >= 200 && res.statusCode < 300) {
                root.lastnotify[notifyid] = new Date
                root.emitter.emit(notifyid)
            }
        })
    }

}
var server_handler_redirect = function(req, res) {
    req.on('error', function(error) {
        console.error('REDIRECT REQUEST ERROR: %s', error.message)
    })
    res.statusCode = 302
    var host = req.headers.host
    if (https_port !== 443)
        host = host.split(':')[0] + ':' + https_port
    res.setHeader('Location', 'https://' + host + req.url)
    res.end('302 Moved')
}
var is_greet = false
var is_getroots = false
var listen_handler = function(port) {
    return function() {
        if (!is_getroots) {
            updateRoots(sites_path, roots, function(allRoots, newRoots) {
                roots = allRoots
                roots.forEach(function(root) {
                    console.error('Site found: %s', root.dir)
                })
            })
            is_getroots = true
        }
        if (!is_greet) {
            console.error('Welcome to XCGI!')
            console.error('Sites path at', sites_path)
            console.error('Max instances is', config.maxInstances)
            console.error('Shell used is', shell)
            console.error('HTTP port is', http_port)
            console.error('HTTPS port is', https_port)
            console.error('Max fields size is %sMB', config.maxFieldsSize)
            console.error('Max file size is %sMB', config.maxFileSize)
            is_greet = true
        }
        console.error('Online at port', port)
    }
}
// MAIN ///////////////////////////////
if (config.http && ! config.redirect) {
    http.createServer(server_handler).listen(http_port, listen_handler(http_port))
}
if (config.http && config.redirect) {
    http.createServer(server_handler_redirect).listen(http_port, listen_handler(http_port))
}
if (config.https) {
    https.createServer(config.httpsOption, server_handler).listen(https_port, listen_handler(https_port))
}
fs.watch(sites_path, function(type, filename) {
    console.error('Reloading sites...')
    updateRoots(sites_path, roots, function(allRoots, newRoots) {
        roots = allRoots
        newRoots.forEach(function(root) {
            console.error('Site found: %s', root.dir)
        })
    })
})
// GARBAGE COLLECTION /////////////////
setInterval(function() {
    /////////////////////////////////
    // CLEAN UP LAST WAIT ID's
    for(var i=0; i<roots.length; i++)
        roots[i].lastwait = {}
    /////////////////////////////////
}, 60 * 60 * 1000) // HOURLY
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
