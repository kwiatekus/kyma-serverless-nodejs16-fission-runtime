"use strict";
const ce = require('./lib/ce');
const helper = require('./lib/helper');
const bodyParser = require('body-parser');
const process = require("process");
const morgan = require("morgan");
const opentelemetry = require('@opentelemetry/api');
const { SpanStatusCode } = require( "@opentelemetry/api/build/src/trace/status");

const {setupTracer} = require('./lib/tracer')


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
serviceName = serviceName.substring(0, serviceName.lastIndexOf("-"))
const functionName = process.env.FUNC_NAME || serviceName;
const bodySizeLimit = Number(process.env.REQ_MB_LIMIT || '1');
const funcPort = Number(process.env.FUNC_PORT || '8080');
const tracer = setupTracer([serviceName, serviceNamespace].join('.'));

//require express must be called AFTER tracer was setup!!!!!!
const express = require("express");
const app = express();

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
        return userFunction;
    } catch (e) {
        console.error(`user code load error: ${e}`);
        return e;
    }
};

const isFunction = (func) => {
    return func && func.constructor && func.call && func.apply;
};

const isPromise = (promise) => {
    return typeof promise.then == "function"
}

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
            'tracer': tracer
        };
    
        const callback = (status, body, headers) => {
            console.log("Calling back")
            if (!status) return;
            if (headers) {
                for (let name of Object.keys(headers)) {
                    res.set(name, headers[name]);
                }
            }
            res.status(status).send(body);
            console.log(`${status}: ${body}`)
        };

        const currentSpan = opentelemetry.trace.getSpan(opentelemetry.context.active());
        const ctx = opentelemetry.trace.setSpan(
            opentelemetry.context.active(),
            currentSpan
        );

        console.log("Creating span for userFunction execution")  
        const span = tracer.startSpan('userFunction', undefined, ctx);  

        try {
            // Execute the user function
            const out = userFunction(event, context, callback);
            if (out){
                if(isPromise(out)){
                    Promise.resolve(out)
                    .then(result => {
                        if(result){
                            callback(200, result);
                        }
                    })
                    .catch((err) => {
                        console.error(err)
                        const errTxt = resolveErrorMsg(err)
                        console.error(errTxt)
                        callback(500, errTxt);
                        span.setStatus({code: SpanStatusCode.ERROR, message: errTxt})
                    });
                } else {
                    callback(200, out)
                }
            }
        } catch (err) {
            let status = err.status || 500
            let errText = resolveErrorMsg(err);
            callback(status, errText);
            span.setStatus({code: SpanStatusCode.ERROR, message: errText})
        } finally {
            span.end()
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


function resolveErrorMsg(err){
    let errText
    if (typeof err == "string") {
        errText = err
    } else {
        errText = err.msg || "Internal server error"
    }
    return errText
}

