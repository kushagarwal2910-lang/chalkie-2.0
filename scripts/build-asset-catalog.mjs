import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
const root = process.cwd();
const packageRoot = path.join(root, "node_modules/devicon");
const icons = JSON.parse(await readFile(path.join(packageRoot, "devicon.json"), "utf8"));
const version = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")).version;
const names = new Set(("amazonwebservices azure azuredevops azuresqldatabase googlecloud cloudrun cloudflare cloudflareworkers digitalocean heroku netlify vercel firebase supabase appwrite docker podman kubernetes k3s helm argocd rancher terraform pulumi ansible packer vagrant nomad consul vault prometheus grafana datadog opentelemetry jaegertracing elasticsearch kibana logstash nginx envoy apache traefik linux ubuntu debian redhat centos fedora bash powershell git github gitlab bitbucket githubactions circleci jenkins bamboo travis sonarqube codecov sentry newrelic dynatrace postgresql mysql mariadb mongodb mongoose redis memcached cassandra couchdb couchbase neo4j dynamodb cosmosdb oracle microsoftsqlserver sqlite influxdb clickhouse duckdb rabbitmq apachekafka nats pulsar apacheairflow apachespark hadoop python pytorch tensorflow keras scikitlearn numpy pandas scipy matplotlib jupyter anaconda googlecolab kaggle kubeflow opencv networkx plotly r julia rust go java kotlin scala clojure elixir erlang ruby rails php laravel symfony dotnetcore dot-net csharp cplusplus c swift dart flutter reactnative expo android apple nodejs denojs bun javascript typescript react nextjs vuejs nuxtjs angular svelte astro remix solidjs qwik express nestjs fastify fastapi django djangorest flask spring quarkus graphql apollographql grpc openapi oauth okta passport prisma knexjs sequelize sqlalchemy hibernate entityframeworkcore webpack vite rollupjs babel esbuild tailwindcss bootstrap materialui chakraui sass less css3 html5 htmx d3js chartjs electron capacitor tauri pnpm npm yarn poetry pypi composer maven gradle nuget pytest jest vitest playwright cypressio mocha cucumber junit k6 postman insomnia browserstack selenium storybook confluence jira notion markdown json yaml vscode intellij pycharm goland webstorm datagrip figma portainer proxmox openstack harbor liquibase streamlit").split(/\s+/));
const display = { amazonwebservices: "Amazon Web Services", postgresql: "PostgreSQL", nextjs: "Next.js", nodejs: "Node.js", apachekafka: "Apache Kafka", googlecloud: "Google Cloud", dotnetcore: ".NET", scikitlearn: "scikit-learn", githubactions: "GitHub Actions" };
const extraAliases = { nextjs: ["next", "next.js"], nodejs: ["node", "node.js"], react: ["react-dom"], amazonwebservices: ["aws", "aws_s3_bucket", "aws_instance", "aws_rds_instance"], googlecloud: ["gcp", "google_compute_instance"], microsoftsqlserver: ["mssql", "sqlserver"], pytorch: ["torch"], kubernetes: ["k8s"], scikitlearn: ["sklearn"] };
const catalog = [];
const destination = path.join(root, "public/architecture-assets");
await mkdir(destination, { recursive: true });
let total = 0;
for (const icon of icons.filter(icon => names.has(icon.name))) {
  const variant = ["original", "plain", "line"].find(v => icon.versions.svg.includes(v)) ?? icon.versions.svg[0];
  const file = icon.name + "-" + variant + ".svg";
  let svg = await readFile(path.join(packageRoot, "icons", icon.name, file), "utf8");
  if (/<(?:script|foreignObject|image)\b|\son\w+\s*=|(?:href|src)\s*=\s*["'](?:https?:|\/\/|data:|javascript:)/i.test(svg)) throw new Error("Unsafe SVG: " + file);
  svg = svg.replace(/<!--[\s\S]*?-->/g, "").replace(/>\s+</g, "><").trim();
  await writeFile(path.join(destination, icon.name + ".svg"), svg);
  total += Buffer.byteLength(svg);
  const aliases = [...new Set([icon.name, ...(extraAliases[icon.name] ?? []), ...(icon.altnames ?? []), ...(icon.name.startsWith("apache") ? [icon.name.slice(6)] : []), ...(icon.name === "amazonwebservices" ? ["aws"] : []), ...(icon.name === "postgresql" ? ["postgres"] : [])])];
  catalog.push({ id: "tech:" + icon.name, name: display[icon.name] ?? icon.name, aliases, categories: icon.tags ?? [], description: "Technology identity for " + (display[icon.name] ?? icon.name) + ". Use only when named in repository evidence.", path: "/architecture-assets/" + icon.name + ".svg", source: "https://github.com/devicons/devicon/tree/v" + version + "/icons/" + icon.name, license: "MIT; brand marks belong to their owners; follow the brand policy.", version });
}
await writeFile(path.join(root, "lib/architecture/asset-catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
await writeFile(path.join(destination, "LICENSE.txt"), await readFile(path.join(packageRoot, "LICENSE"), "utf8"));
await writeFile(path.join(destination, "NOTICE.txt"), "Curated from Devicon " + version + ". Product names, logos and brands belong to their respective owners and identify technologies, without implying endorsement. Follow each brand's usage policy. Source/version: lib/architecture/asset-catalog.json.\nGeneric concept illustrations: Lucide, ISC, https://lucide.dev/license\n");
console.log("Curated " + catalog.length + " technology SVGs; " + Math.round(total / 1024) + " KiB total. Assets load individually.");
