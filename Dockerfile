FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN mkdir -p public/uploads backups

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "app.js"]
