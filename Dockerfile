FROM node:22-bookworm-slim

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=3000
ENV DATA_VOLUME_PATH=/data
EXPOSE 3000
VOLUME ["/data"]
CMD ["npm", "start"]
