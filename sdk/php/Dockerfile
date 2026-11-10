# RecoverKit Connector as a container, for servers without PHP (Node, Python, Go, Java, .NET...).
#
#   docker build -t recoverkit-connector sdk/php
#
#   # Setup once (answers questions in your terminal):
#   docker run --rm -it --network host \
#     -v /path/to/your/app:/app:ro -v recoverkit-state:/state \
#     -e RK_PUBLIC_KEY -e RK_SECRET_KEY -e RK_ENDPOINT \
#     recoverkit-connector setup --app=/app --dir=/state
#
#   # Then from cron every 15 minutes:
#   docker run --rm --network host -v /path/to/your/app:/app:ro -v recoverkit-state:/state \
#     -e RK_PUBLIC_KEY -e RK_SECRET_KEY -e RK_ENDPOINT recoverkit-connector sync --app=/app --dir=/state
#
# The app folder is mounted read-only: the connector only reads its config files to find the
# database login. --network host lets "localhost" mean your server (on Docker Desktop use
# host.docker.internal as the database host instead). Set RK_DB_USER / RK_DB_PASS to use a
# read-only database login instead of the app's own.
FROM php:8.3.13-cli-alpine3.20

RUN apk add --no-cache postgresql-libs \
 && apk add --no-cache --virtual .build postgresql-dev \
 && docker-php-ext-install pdo_mysql pdo_pgsql \
 && apk del .build \
 && adduser -D -H -u 10001 recoverkit \
 && mkdir /state && chown recoverkit /state

COPY RecoverKit.php recoverkit-detect.php recoverkit-connector.php /opt/recoverkit/

USER recoverkit
WORKDIR /state
ENTRYPOINT ["php", "/opt/recoverkit/recoverkit-connector.php"]
CMD ["status", "--dir=/state"]
