# Dockerfile pentru Enigma2 HLS Proxy cu FFmpeg
FROM node:20-alpine

# Instalare FFmpeg și dependențe necesare
RUN apk add --no-cache \
    ffmpeg \
    && rm -rf /var/cache/apk/*

# Creare director de lucru
WORKDIR /app

# Copiere package.json și instalare dependențe
COPY package*.json ./
RUN npm ci --only=production

# Copiere cod sursă
COPY . .

# Creare director pentru HLS temporar
RUN mkdir -p /app/tmp/hls

# Expunere port
EXPOSE 8080

# Variabile de mediu (opțional)
ENV NODE_ENV=production
ENV PORT=8080

# Verificare FFmpeg instalat
RUN ffmpeg -version

# Start aplicație
CMD ["node", "proxy.js"]
