FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .

ENV BROKER_URL=mqtt://broker:1883
ENV HTTP_PORT=4000
ENV DATABASE_URL=postgresql://aerotrack:aerotrack@banco:5432/aerotrack

EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD wget -qO- http://localhost:4000/status || exit 1

CMD ["node", "server.js"]
