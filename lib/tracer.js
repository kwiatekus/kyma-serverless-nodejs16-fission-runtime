'use strict';

const { Sampler, SpanKind } = require( "@opentelemetry/api");
const opentelemetry = require('@opentelemetry/api');

const { ParentBasedSampler, AlwaysOffSampler, AlwaysOnSampler } = require( '@opentelemetry/core');
const { registerInstrumentations } = require( '@opentelemetry/instrumentation');
const { NodeTracerProvider } = require( '@opentelemetry/sdk-trace-node');
const { SimpleSpanProcessor } = require( '@opentelemetry/sdk-trace-base');
const { JaegerExporter } = require( '@opentelemetry/exporter-jaeger');
const { Resource } = require( '@opentelemetry/resources');
const { SemanticAttributes, SemanticResourceAttributes } = require( '@opentelemetry/semantic-conventions');
const { SpanAttributes } = require( "@opentelemetry/api/build/src/trace/attributes");
const {B3Propagator, B3InjectEncoding} = require("@opentelemetry/propagator-b3");

const Exporter =  JaegerExporter;
const { ExpressInstrumentation } = require( '@opentelemetry/instrumentation-express');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const axios = require("axios")

function setupTracing(serviceName){

  const jaegerServiceEndpoint = process.env.JAEGER_SERVICE_ENDPOINT ? process.env.JAEGER_SERVICE_ENDPOINT : "http://localhost:3000"
  if(!isJeagerAvailable(jaegerServiceEndpoint)){
    return;
  }

  const provider = new NodeTracerProvider({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    }),

    //TODO: use parent based sampler or TRACER_SAMPLE_HEADER = "x-b3-sampled"
    sampler: filterSampler(
        ignoreIrrelevantTargtes,
        // new ParentBasedSampler({
        //     root: new AlwaysOffSampler(),
        //     remoteParentNotSampled: new AlwaysOnSampler(),
        // })
        new AlwaysOnSampler()
    ),
    propagator: new B3Propagator({injectEncoding: B3InjectEncoding.MULTI_HEADER}),

  });
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      HttpInstrumentation,
      ExpressInstrumentation,
    ],
  });

  const exporter = new Exporter({
    serviceName,
    endpoint: jaegerServiceEndpoint,
  });

  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));

  // Initialize the OpenTelemetry APIs to use the NodeTracerProvider bindings
  provider.register();


  return opentelemetry.trace.getTracer(serviceName);
};

// type FilterFunction = (spanName: string, spanKind: SpanKind, attributes: SpanAttributes) => boolean;

function filterSampler(filterFn, parent) {
  return {
    shouldSample(ctx, tid, spanName, spanKind, attr, links) {
      if (!filterFn(spanName, spanKind, attr)) {
        return { decision: opentelemetry.SamplingDecision.NOT_RECORD };
      }
      return parent.shouldSample(ctx, tid, spanName, spanKind, attr, links);
    },
    toString() {
      return `FilterSampler(${parent.toString()})`;
    }
  }
}

function ignoreIrrelevantTargtes(spanName, spanKind, attributes) {
  return !ignoredTargets.includes(attributes['http.target'])
}

const ignoredTargets = [
    "/healthz", "/favicon.ico", "/metrics"
]

module.exports = {
    setupTracing
}

async function isJeagerAvailable(endpoint){
  let jeagerAvailable = false;
  await axios(endpoint)
  .then(response => {
     console.log('resopose from jaeger ', response);  
  })
  .catch((err) => {
    // 405 is the right status code for the GET method if jaeger service exists
    // because the only allowed method is POST and usage of other methods are not allowe
    // https://github.com/jaegertracing/jaeger/blob/7872d1b07439c3f2d316065b1fd53e885b26a66f/cmd/collector/app/handler/http_handler.go#L60
    if (err.response && err.response.status === 405) {
       jeagerAvailable = true;
    }
  });

  return jeagerAvailable;
}