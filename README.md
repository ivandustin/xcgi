# XCGI

As `grep` is a utility for searching, and `cat` is a utility for
concatenating, `xcgi` is a utility for serving HTTP requests. It is a 
web server on the fly.

XCGI is not a direct implementation of CGI, hence the prefix `X`. But its 
interface resembles CGI. It uses `bash` as the main program in serving HTTP 
requests. It implements RESTful interface as its core design.

## Installation

Clone this repository and do:

```
cd xcgi
npm install -g
```

## Dependencies

All you need is `nodejs` and `bash`. Therefore in Windows you have to install
`MSys/MinGW` or `cygwin` to have Unix environment.

## Hello World Example

We want to create a hello world RESTful Web Service. First create a `sites`
folder.

```
mkdir sites
```

Our domain name is `localhost` and we want to create our API under 
`localhost/api` basename. We create the following folder inside 
`sites`.

```
cd sites
mkdir localhost_api
```

The `localhost_api` will be our root folder, or the `DOCUMENT_ROOT` in 
terms of CGI. Now we want to create a `pet` resource. Create a folder inside the
document root with name `pet`.

```
cd localhost_api
mkdir pet
```

Now we create a file called `index.sh` to handle `GET` request without a
`pet_id` in terms of RESTful interface.

```
cd pet
echo "echo Hello, world." > index.sh
```

Now go to the parent directory of your `sites` folder and run XCGI.

```
cd ../../../
xcgi sites -h
```

XCGI runs at port 80 with `-h` option which means 'use HTTP only.' Now open
your browser and go to `http://localhost/api/pet`. You should see the
`Hello, world.` text.

If you want to use a particular domain name, say `www.helloworld.com`, replace
`localhost_api` root folder into `www.helloworld.com_api`. You may now access
your web page using `http://www.helloworld.com/api`. XCGI is designed to host
multiple web sites with different domain names in a single machine and port 
number.

If you want to remove the `/api` base path, rename the root folder to

```
mv localhost_api localhost
```

or simply underscore.

```
mv localhost_api _
```

This means you can omit the `localhost` and just use `_`. Therefore 
`localhost_api` is the same as `_api` folder name.

## Accessing Request Data

Generally all request data is exported in environment variable. You may use
`env` program (in `index.sh`) to print and explore all the available 
request data.

### Resource ID

For example, `/pet/<id>` resource. You may get the `<id>` value using 
`$QUERY_ID` or `$QUERY_PET_ID` environment variable.

### Query String

You may access the query string of a request from the environment variable
`$QUERY_<NAME>` in the `bash` script.

### Form URL Encoded (POST)

Access POST request fields/data from `$_POST_<NAME>` environment variable.

### File Uploads

File uploads are automatically handled. Once the file has been uploaded, you
may access the uploaded file using `$_FILE_<NAME>`. Its value is a file path
to the uploaded file (generally located at OS temporary directory). You can
move it afterwards using `mv` program.

### Request Headers

You may access request headers using `$HTTP_<HEADER NAME>` environment variable.

## Author

Ivan Dustin Bilon <ivan22.dust@gmail.com>

Copyright (c) 2017

