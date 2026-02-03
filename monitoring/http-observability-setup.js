const winston = require('winston');
const promClient = require('prom-client');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { trace, context } = require('@opentelemetry/api');
const ObservabilityHttpClient = require('./http-transmission-client');
const config = require('./config');

// Initialize Prometheus metrics
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10],
  registers: [register]
});

const activeConnections = new promClient.Gauge({
  name: 'active_connections',
  help: 'Number of active connections',
  registers: [register]
});

// Initialize HTTP client
const httpClient = new ObservabilityHttpClient();

// Batch processing for HTTP transmission
class HttpBatchProcessor {
  constructor() {
    this.logs = [];
    this.metrics = [];
    this.traces = []; // Stores spans
    this.batchSize = config.HTTP_BATCH_SIZE;
    this.batchTimeout = config.HTTP_BATCH_TIMEOUT;
    this.timeout = null;
  }

  addLog(log) {
    this.logs.push(log);
    this.checkBatchSize();
  }

  addMetric(metric) {
    this.metrics.push(metric);
    this.checkBatchSize();
  }

  addTrace(traceItem) {
    if (Array.isArray(traceItem)) {
      this.traces.push(...traceItem);
    } else {
      this.traces.push(traceItem);
    }
    this.checkBatchSize();
  }

  checkBatchSize() {
    if (this.logs.length + this.metrics.length + this.traces.length >= this.batchSize) {
      this.flush();
    } else if (!this.timeout) {
      this.timeout = setTimeout(() => this.flush(), this.batchTimeout);
    }
  }

  async flush() {
    if (this.logs.length === 0 && this.metrics.length === 0 && this.traces.length === 0) {
      return;
    }

    const batch = {
      logs: [...this.logs],
      metrics: [...this.metrics],
      traces: [...this.traces]
    };

    // Clear arrays
    this.logs = [];
    this.metrics = [];
    this.traces = [];

    // Clear timeout
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }

    // Send batch
    try {
      await httpClient.sendBatch(batch);
    } catch (error) {
      console.error('❌ Failed to send batch:', error.message);
    }
  }
}

const batchProcessor = new HttpBatchProcessor();

// Custom Exporter to adapter OTel spans to our HTTP Batch format
class CustomHttpExporter {
  export(spans, resultCallback) {
    const formattedSpans = spans.map(span => {
      const ctx = span.spanContext();
      return {
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        parentSpanId: span.parentSpanId,
        operationName: span.name,
        // Convert hrTime [seconds, nanoseconds] to ISO string
        startTime: new Date(span.startTime[0] * 1000 + span.startTime[1] / 1000000).toISOString(),
        // Duration in microseconds
        duration: (span.duration[0] * 1000000 + span.duration[1] / 1000),
        tags: span.attributes,
        service: config.SERVICE_NAME,
        is_span: true // Flag for backend to identify this as a span
      };
    });

    batchProcessor.addTrace(formattedSpans);
    resultCallback({ code: 0 });
  }

  shutdown() {
    return Promise.resolve();
  }
}

// Start OpenTelemetry SDK with Auto-Instrumentation
const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: config.SERVICE_NAME,
    [SemanticResourceAttributes.SERVICE_VERSION]: config.SERVICE_VERSION,
  }),
  instrumentations: [getNodeAutoInstrumentations()],
  spanProcessor: new SimpleSpanProcessor(new CustomHttpExporter()),
});

try {
  sdk.start();
} catch (err) {
  console.error('❌ Failed to start OpenTelemetry SDK:', err);
}

// Custom Winston transport for HTTP transmission
class HttpTransport extends winston.Transport {
  constructor(options) {
    super(options);
    this.name = 'http';
    this.level = options.level || 'info';
  }

  log(info, callback) {
    if (this.silent) {
      return callback();
    }

    // Try to get current trace context
    let traceId = null;
    let spanId = null;
    
    try {
        const activeSpan = trace.getSpan(context.active());
        if (activeSpan) {
            const ctx = activeSpan.spanContext();
            traceId = ctx.traceId;
            spanId = ctx.spanId;
        }
    } catch (e) {
        // Ignore context errors
    }

    const logEntry = {
      timestamp: info.timestamp || new Date().toISOString(),
      level: info.level,
      message: info.message,
      service: config.SERVICE_NAME,
      version: config.SERVICE_VERSION,
      environment: config.NODE_ENV,
      traceId: traceId || info.traceId,
      spanId: spanId || info.spanId,
      ...info
    };

    batchProcessor.addLog(logEntry);
    callback();
  }
}

// Initialize Winston logger with HTTP transport
const initLogger = () => {
  const logger = winston.createLogger({
    level: config.LOG_LEVEL,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    defaultMeta: {
      service: config.SERVICE_NAME,
      version: config.SERVICE_VERSION,
      environment: config.NODE_ENV,
    },
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        ),
      }),
    ],
  });

  // Add HTTP transport if enabled
  if (config.HTTP_TRANSMISSION_ENABLED) {
    logger.add(new HttpTransport({
      level: 'info'
    }));
  }

  return logger;
};

// Setup observability middleware
const setupObservability = (app) => {
  const logger = initLogger();
  // Get OTel tracer
  const tracer = trace.getTracer(config.SERVICE_NAME);

  // Health check endpoint
  app.get('/health', (req, res) => {
    const healthStatus = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: config.SERVICE_NAME,
      version: config.SERVICE_VERSION,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    };

    if (config.HTTP_TRANSMISSION_ENABLED) {
      httpClient.sendHealthStatus(healthStatus).catch(err => {
        console.error('Failed to send health status:', err.message);
      });
    }

    res.json(healthStatus);
  });

  // Request logging and metrics middleware
  app.use((req, res, next) => {
    const start = Date.now();
    
    // Attempt to get traceId for logs and summary
    let traceId = null;
    try {
        const activeSpan = trace.getSpan(context.active());
        if (activeSpan) {
             traceId = activeSpan.spanContext().traceId;
             req.traceId = traceId;
        }
    } catch (e) { }

    const userContext = {
      apiKey: req.observabilityApiKey ? req.observabilityApiKey.substring(0, 8) + '...' : null,
      repositoryUrl: req.repositoryUrl,
      projectName: req.projectName,
      organisationID: req.organisationID,
      projectID: req.projectID
    };

    logger.info('Incoming request', {
      method: req.method,
      url: req.url,
      userAgent: req.get('User-Agent'),
      ...userContext,
    });
    
    const originalEnd = res.end;
    res.end = function(chunk, encoding) {
      const duration = (Date.now() - start) / 1000;

      // Update Prometheus metrics
      httpRequestsTotal.inc({
        method: req.method,
        route: req.route?.path || req.path,
        status_code: res.statusCode,
      });

      httpRequestDuration.observe({
        method: req.method,
        route: req.route?.path || req.path,
        status_code: res.statusCode,
      }, duration);

      activeConnections.set(1); 

      // Send metrics via HTTP if enabled
      if (config.HTTP_TRANSMISSION_ENABLED) {
        const metricData = {
          name: 'http_request_duration_seconds',
          value: duration,
          labels: {
            method: req.method,
            route: req.route?.path || req.path,
            status_code: res.statusCode.toString()
          },
          timestamp: new Date().toISOString()
        };
        batchProcessor.addMetric(metricData);
      }

      logger.info('Request completed', {
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        duration: duration,
        traceId: req.traceId,
        ...userContext,
      });

      // Send Trace Summary (User Experience)
      if (config.HTTP_TRANSMISSION_ENABLED && req.traceId) {
        const traceSummary = {
          traceId: req.traceId,
          duration: duration * 1000000,
          spans: 1,
          timestamp: new Date().toISOString(),
          url: req.url,
          path: req.route?.path || req.path,
          method: req.method,
          service: config.SERVICE_NAME,
          is_trace_summary: true
        };
        batchProcessor.addTrace(traceSummary);
      }

      originalEnd.call(this, chunk, encoding);
    };

    next();
  });

  // No-op functions for backward compatibility
  const createChildSpan = (req, name, tags) => {
    const span = trace.getSpan(context.active());
    if (span && tags) {
        for (const [key, value] of Object.entries(tags)) {
            span.setAttribute(key, value);
        }
    }
    return span;
  };

  const finishChildSpan = (span, tags) => {
    if (span && tags) {
         for (const [key, value] of Object.entries(tags)) {
            span.setAttribute(key, value);
        }
    }
  };
  
  const serializeSpan = () => ({});

  return { 
    logger, 
    tracer, 
    metrics: { httpRequestsTotal, httpRequestDuration, activeConnections },
    httpClient,
    batchProcessor,
    createChildSpan,
    finishChildSpan,
    serializeSpan
  };
};

module.exports = {
  setupObservability,
  initLogger,
  register,
  httpRequestsTotal,
  httpRequestDuration,
  activeConnections,
  ObservabilityHttpClient
};