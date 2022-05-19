/* tracing.js */

// Require dependencies
const opentelemetry = require("@opentelemetry/sdk-node");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const { JaegerExporter } = require( '@opentelemetry/exporter-jaeger');


function setupTracing(serviceName){

const jaegerServiceEndpoint = process.env.JAEGER_SERVICE_ENDPOINT ? process.env.JAEGER_SERVICE_ENDPOINT : "http://localhost:3000"


const exporter = new JaegerExporter({
  serviceName,
  endpoint: jaegerServiceEndpoint,
});

const sdk = new opentelemetry.NodeSDK({
  traceExporter: exporter,
  instrumentations: [getNodeAutoInstrumentations()]
});

sdk.start()
}

module.exports = {
    setupTracing
}