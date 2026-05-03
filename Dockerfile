FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
