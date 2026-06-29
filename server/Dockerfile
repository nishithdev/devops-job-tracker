FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./

RUN mkdir -p /data

ENV PORT=3747
ENV DB_PATH=/data/scanner.db

EXPOSE 3747

CMD ["node", "server.js"]
