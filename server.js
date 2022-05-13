"use strict";
const {setupTracing} = require('./lib/tracer')
const ce = require('./lib/ce');

const fs = require("fs");
const path = require("path");
const process = require("process");
const express = require("express");
const request = require("request");
const app = express();
const morgan = require("morgan");
const WSServer = require("ws").Server;
const argv = require("minimist")(process.argv.slice(1)); // Command line opts

const util = require("util");



if (!argv.port) {
    argv.port = 8080;
}
// console.log(argv.port)


// Interval at which we poll for connections to be active
var timeout;
if (process.env.TIMEOUT) {
    timeout = process.env.TIMEOUT;
} else {
    timeout = 60000;
}


// To catch unhandled exceptions thrown by user code async callbacks,
// these exceptions cannot be catched by try-catch in user function invocation code below
process.on("uncaughtException", (err) => {
    console.error(`Caught exception: ${err}`);
});

// Tracing Imports
const podName = process.env.HOSTNAME || ""
const serviceNamespace = process.env.SERVICE_NAMESPACE || ""

// remove generated pods suffix ( two last sections )
let serviceName = podName.substring(0, podName.lastIndexOf("-"));
serviceName = serviceName.substring(0, serviceName.lastIndexOf("-"))

const tracer = setupTracing([serviceName, serviceNamespace].join('.'));

// User function.  Starts out undefined.
let userFunction;

const loadFunction = (modulepath, funcname) => {
    // Read and load the code. It's placed there securely by the fission runtime.
    try {
        let startTime = process.hrtime();
        // support v1 codepath and v2 entrypoint like 'foo', '', 'index.hello'
        let userFunction = funcname
            ? require(modulepath)[funcname]
            : require(modulepath);
        let elapsed = process.hrtime(startTime);
        console.log(
            `user code loaded in ${elapsed[0]}sec ${elapsed[1] / 1000000}ms`
        );
        console.log(userFunction)
        return userFunction;
    } catch (e) {
        console.error(`user code load error: ${e}`);
        return e;
    }
};

const withEnsureGeneric = (func) => {
    return (req, res) => {
        // Make sure we're a generic container.  (No reuse of containers.
        // Once specialized, the container remains specialized.)
        // console.log("starting registering function")
        if (userFunction) {
            res.status(400).send("Not a generic container");
            return;
        }

        func(req, res);
    };
};

const isFunction = (func) => {
    return func && func.constructor && func.call && func.apply;
};

const specializeV2 = (req, res) => {
     console.log("specialize v2")
    // for V2 entrypoint, 'filename.funcname' => ['filename', 'funcname']
    const entrypoint = req.body.functionName
        ? req.body.functionName.split(".")
        : [];
    // for V2, filepath is dynamic path
    const modulepath = "./" + path.join(req.body.filepath, entrypoint[0] || "");
    const result = loadFunction(modulepath, entrypoint[1]);

    console.log(modulepath, entrypoint)
    if (isFunction(result)) {
        userFunction = result;
        res.status(202).send();
    } else {
        res.status(500).send(JSON.stringify(result));
    }
};

const specialize = (req, res) => {
    // Specialize this server to a given user function.  The user function
    // is read from argv.codepath; it's expected to be placed there by the
    // fission runtime.
    //
    const modulepath = argv.codepath || "/userfunc/user";

    // Node resolves module paths according to a file's location. We load
    // the file from argv.codepath, but tell users to put dependencies in
    // the server's package.json; this means the function's dependencies
    // are in /usr/src/app/node_modules.  We could be smarter and have the
    // function deps in the right place in argv.codepath; b ut for now we
    // just symlink the function's node_modules to the server's
    // node_modules.
    // Check for symlink, because the link exists if the container restarts
    if (!fs.existsSync(`${path.dirname(modulepath)}/node_modules`)) {
        fs.symlinkSync(
            "/usr/src/app/node_modules",
            `${path.dirname(modulepath)}/node_modules`
        );
    }
    const result = loadFunction(modulepath);
    // console.log(result)
    if (isFunction(result)) {
        userFunction = result;
        res.status(202).send();
    } else {
        res.status(500).send(JSON.stringify(result));
    }
};

// Request logger
if (process.env["KYMA_INTERNAL_LOGGER_ENABLED"]) {
    app.use(morgan("combined"));
}

let bodyParserLimit = process.env.BODY_PARSER_LIMIT || "1mb";

app.use(express.urlencoded({extended: false, limit: bodyParserLimit}));
app.use(express.json({limit: bodyParserLimit}));
app.use(express.raw({limit: bodyParserLimit}));
app.use(express.text({type: "text/*", limit: bodyParserLimit}));

app.post("/specialize", withEnsureGeneric(specialize));
app.post("/v2/specialize", withEnsureGeneric(specializeV2));

app.get("/healthz", (req, res) => {
    res.status(200).send("")
})

// Generic route -- all http requests go to the user function.
app.all("*", (req, res) => {
    if (!userFunction) {
        // console.log(userFunction)
        res.status(500).send("Generic container: no requests supported");
        return;
    }

    //
    // Customizing the request event and context
    //
    // If you want to modify the passed arguments ( i.e to add anything to it,
    // you can do that here by adding properties to the event and context.
    //
    const event = ce.buildEvent(req, res, tracer);

    const funcHandler = process.env.FUNC_HANDLER;

    //TODO take into account Christian's input
    const context = {
        'function-name': funcHandler,
        'runtime': process.env.FUNC_RUNTIME,
        'memory-limit': process.env.FUNC_MEMORY_LIMIT
    };

    const callback = (status, body, headers) => {
        if (!status) return;
        if (headers) {
            for (let name of Object.keys(headers)) {
                res.set(name, headers[name]);
            }
        }
        res.status(status).send(body);
    };


    if (userFunction.length <= 2) {
        
        let result;
        // Make sure their function returns a promise
        if (userFunction.length === 0) {
            result = Promise.resolve(userFunction());
        } if (userFunction.length === 1) {
            result = Promise.resolve(userFunction(event));
        } else {
            result = Promise.resolve(userFunction(event, context));
        }
        result
            .then(({status, body, headers}) => {
                callback(status, body, headers);
            })
            .catch((err) => {
                console.log(`Function error: ${err}`);
                callback(500, "Internal server error");
            });
    } else {
        // 3 arguments (event, context, callback)
        console.log('3 params')
        try {
            const out = userFunction(event, context, callback);
            callback(200, out)
        } catch (err) {
            console.log(`Function error: ${err}`);
            callback(500, "Internal server error");
        }
    }
});

let server = require("http").createServer();

// Also mount the app here
server.on("request", app);

const wsStartEvent = {
    url: "http://127.0.0.1:8000/wsevent/start",
};

const wsInactiveEvent = {
    url: "http://127.0.0.1:8000/wsevent/end",
};

// Create web socket server on top of a regular http server
let wss = new WSServer({
    server: server,
});

const noop = () => {
};

const heartbeat = () => {
    this.isAlive = true;
};
// warm indicates whether this pod has ever been active
var warm = false;

let interval;
interval = setInterval(() => {
    if (warm) {
        if (wss.clients.size > 0) {
            wss.clients.forEach((ws) => {
                // We check if all connections are alive
                if (ws.isAlive === false) return ws.terminate();

                ws.isAlive = false;
                // If client replies, we execute the hearbeat function(pong) and set the connection as active
                ws.ping(noop);
            });
        } else {
            // After we have pinged all clients and verified number of active connections is 0, we generate event for inactivity on the websocket
            request(wsInactiveEvent, (err, res) => {
                if (err || res.statusCode != 200) {
                    if (err) {
                        console.log(err);
                    } else {
                        console.log("Unexpected response");
                    }
                    ws.send("Error");
                    return;
                }
            });
            return;
        }
    }
}, timeout);

wss.on("connection", (ws) => {
    if (warm == false) {
        warm = true;
        // On successful request, there's no body returned
        request(wsStartEvent, (err, res) => {
            if (err || res.statusCode != 200) {
                if (err) {
                    console.log(err);
                } else {
                    console.log("Unexpected response");
                }
                ws.send("Error");
                return;
            }
        });
    }

    ws.isAlive = true;
    ws.on("pong", heartbeat);

    wss.on("close", () => {
        clearInterval(interval);
    });

    try {
        userFunction(ws, wss.clients);
    } catch (err) {
        console.log(`Function error: ${err}`);
        ws.close();
    }
});

server.listen(argv.port, () => {
});

const handlerInfo = {
    json: {
        functionName: "handler",
        filepath: "function"
    }
}

// console.log("can't register function, trying manually")
const fn = loadFunction("./function/handler", "");
if (isFunction(fn.main)) {
    console.log("I feel like function")
    userFunction = fn.main
} else {
    // console.log("I don't identyfi as function")
}
console.log(fn)

request.post(util.format("http://localhost:%s/v2/specialize", argv.port), handlerInfo, function (error, response, body) {
    console.error('error:', error); // Print the error if one occurred
    console.log('statusCode:', response && response.statusCode); // Print the response status code if a response was received
    console.log('body:', body); // Print the HTML for the Google homepage.
    if (response && response.statusCode === 500) {

    }
})

