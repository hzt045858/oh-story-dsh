import { createServer } from "node:http";
import process from "node:process";
import { setTimeout } from "node:timers";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const token = "mock-desktop-process-token";
const server = createServer((request, response) => {
  if (request.url === `/?token=${token}`) {
    response.writeHead(302, { "set-cookie": "dsh-session=fixture; HttpOnly; SameSite=Strict", location: "/" });
    response.end();
  } else response.writeHead(401).end();
});
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`dsh web: http://127.0.0.1:${port}/?token=mock-desktop-`);
  setTimeout(() => process.stdout.write("process-token\n"), 20);
});
process.once("SIGTERM", () => server.close(() => process.exit(0)));
