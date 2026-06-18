FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY simulator.js .

ENV BROKER_URL=mqtt://broker:1883
ENV CALLSIGN=XX0000
ENV AIRLINE=TEST
ENV IATA_AIRLINE=XT
ENV ORIGIN=GRU
ENV DESTINATION=GIG
ENV UPDATE_MS=1000

CMD ["node", "simulator.js"]
