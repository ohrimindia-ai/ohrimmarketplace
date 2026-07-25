FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p public/uploads
EXPOSE 5000
CMD ["node", "server.js"]
