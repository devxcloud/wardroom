FROM jaegertracing/jaeger:2.21.0@sha256:3d0ac795ff98aa04d1be04311d2dac6c25b4bfc8322dc02e53bc5b170c5018c3
COPY observability/jaeger.yaml /etc/jaeger/config.yaml
CMD ["--config", "/etc/jaeger/config.yaml"]
