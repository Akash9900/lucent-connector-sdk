FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY tsconfig.json jest.config.js .eslintrc.js ./
COPY src ./src

RUN npm run build

CMD ["node", "dist/index.js"]

