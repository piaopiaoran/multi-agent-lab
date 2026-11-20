import { SEED_DOCUMENTS } from "../data/knowledge.js";
import { clearKnowledge, addDocuments, similaritySearch } from "../memory/vector-store.js";
import { closePool } from "../memory/pg-pool.js";
import { describeRuntime } from "../config.js";

console.log("运行配置：", describeRuntime());
await clearKnowledge();
const count = await addDocuments(SEED_DOCUMENTS);
console.log(`✓ 已写入 ${count} 条知识块`);

const hits = await similaritySearch("Supervisor 和 Swarm 拓扑有什么区别？", { k: 3 });
console.log("✓ 检索自检：");
for (const h of hits) {
  console.log(`   score=${h.score.toFixed(3)} [${h.metadata?.topic}] ${h.content.slice(0, 46)}…`);
}
await closePool();
