# Ewidencja Palet — serwer lokalny w kontenerze (Synology Container Manager / Docker).
# Zbudowanie i start:  docker compose up -d --build     (patrz docker-compose.yml)
FROM node:22-alpine

# Strefa czasowa (daty kopii dziennych): Node ma wbudowaną bazę stref (ICU), więc TZ=Europe/Warsaw
# działa bez pakietu tzdata — obraz buduje się bez dostępu do repozytoriów Alpine.
# EP_DOCKER=1: serwer wie, że działa w kontenerze — w logu nie podaje wewnętrznego adresu Dockera
# (np. 172.18.0.2) jako adresu w sieci lokalnej, tylko wskazówkę: adres NAS-a i port z docker-compose.yml.
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/dane \
    TZ=Europe/Warsaw \
    EP_DOCKER=1

WORKDIR /app
COPY --chown=node:node server.js index.html runtime-lokalny.js ./
COPY --chown=node:node fonts ./fonts
COPY --chown=node:node narzedzia/kontrola-zdrowia.js ./narzedzia/
RUN mkdir -p /app/dane && chown node:node /app/dane

# domyślnie bez uprawnień roota (docker-compose.yml może wystartować jako root tylko po to,
# żeby nadać folderowi danych właściciela — serwer od razu przechodzi wtedy na zwykłego użytkownika)
USER node

VOLUME /app/dane
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "narzedzia/kontrola-zdrowia.js"]

CMD ["node", "server.js"]
