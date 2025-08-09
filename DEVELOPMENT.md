# Development

## Run UI

Please refer to the [README.md in the ui directory](ui/README.md) for more details.

## Run REST API

Please refer to the [README.md in the rest directory](rest/README.md) for more details.

## Run Jaeger

```bash
docker run -d --name jaeger \
  -e COLLECTOR_OTLP_ENABLED=true \
  -p 16686:16686 \
  -p 14268:14268 \
  -p 14250:14250 \
  -p 4317:4317 \
  -p 4318:4318 \
  cr.jaegertracing.io/jaegertracing/jaeger:2.8.0
```

## Run SDK

Please refer to the [README.md in the traceroot-sdk directory](https://github.com/traceroot-ai/traceroot-sdk) with local mode enabled.
