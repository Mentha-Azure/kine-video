// 调试工具：打印 CLI 链路上的 argv（隔离参数传递问题用）
console.log(JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), kineCwd: process.env.KINE_CWD ?? null }, null, 1));
