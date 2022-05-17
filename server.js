"use strict";
const {setupTracing} = require('./lib/tracer')
const ce = require('./lib/ce');
const helper = require('./lib/helper');

const bodyParser = require('body-parser');
const process = require("process");
const express = require("express");
const app = express();
const morgan = require("morgan");




// To catch unhandled exceptions thrown by user code async callbacks,
// these exceptions cannot be catched by try-catch in user function invocation code below
process.on("uncaughtException", (err) => {
    console.error(`Caught exception: ${err}`);
});

const timeout = Number(process.env.FUNC_TIMEOUT || '180');
const podName = process.env.HOSTNAME || ""
const serviceNamespace = process.env.SERVICE_NAMESPACE || ""
let serviceName = podName.substring(0, podName.lastIndexOf("-"));
serviceName = serviceName.substring(0, serviceName.lastIndexOf("-"))
const functionName = process.env.FUNC_NAME || serviceName;
const bodySizeLimit = Number(process.env.REQ_MB_LIMIT || '1');
const funcPort = Number(process.env.FUNC_PORT || '8080');
const {tracer, api} = setupTracing([serviceName, serviceNamespace].join('.'));

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
        // console.log(userFunction)
        return userFunction;
    } catch (e) {
        console.error(`user code load error: ${e}`);
        return e;
    }
};

const isFunction = (func) => {
    return func && func.constructor && func.call && func.apply;
};


// Request logger
if (process.env["KYMA_INTERNAL_LOGGER_ENABLED"]) {
    app.use(morgan("combined"));
}


const bodParserOptions = {
    type: req => !req.is('multipart/*'),
    limit: `${bodySizeLimit}mb`,
};
app.use(bodyParser.raw(bodParserOptions));
app.use(bodyParser.json({limit: `${bodySizeLimit}mb`}));
app.use(bodyParser.urlencoded({limit: `${bodySizeLimit}mb`, extended: true}));

app.get("/healthz", (req, res) => {
    res.status(200).send("")
})

// Generic route -- all http requests go to the user function.
app.all("*", (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        // CORS preflight support (Allow any method or header requested)
        res.header('Access-Control-Allow-Methods', req.headers['access-control-request-method']);
        res.header('Access-Control-Allow-Headers', req.headers['access-control-request-headers']);
        res.end();
    } else {

        if (!userFunction) {
            // console.log(userFunction)
            res.status(500).send("Generic container: no requests supported");
            return;
        }
    
        const event = ce.buildEvent(req, res);
    
        const context = {
            'function-name': functionName,
            'runtime': process.env.FUNC_RUNTIME,
            'namespace': serviceNamespace,
            'opentelemetry': {api,tracer, context:api.context.active()}
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
    
        try {
            // Execute the user function
            const out = userFunction(event, context, callback);

            //if user function returns a defined object return it in the response
            if(out){
                callback(200, out)
            }
        } catch (err) {
            let status = err.status || 500
            let body = err.msg || "Internal server error"
            callback(status, body);
        }
    }
  
});

const server = app.listen(funcPort);
helper.configureGracefulShutdown(server);

const fn = loadFunction("./function/handler", "");
if (isFunction(fn.main)) {
    userFunction = fn.main
} else {
    console.error("Content loaded is not a function", fn)
}

