FROM eclipse-mosquitto:2.0
COPY mosquitto.conf /mosquitto/config/mosquitto.conf
RUN mkdir -p /mosquitto/data /mosquitto/log && \
    chown -R mosquitto:mosquitto /mosquitto
EXPOSE 1883 9001
HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD mosquitto_sub -h localhost -p 1883 -t '$SYS/broker/uptime' -C 1 -W 3 || exit 1
