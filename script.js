/* base */
:root { --bg:#fff; --fg:#111; --sub:#555; --card:#f9f9fb; --line:#e5e7eb; }
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
a{color:#0b6efb;text-decoration:none} a:hover{text-decoration:underline}
h1,h2{line-height:1.2;margin:0 0 .5rem} h1{font-size:28px} h2{font-size:22px}
.muted{color:var(--sub)}

/* layout */
.site-header,.site-footer{max-width:1100px;margin:0 auto;padding:16px 20px}
nav a{margin-right:14px}
.container{max-width:1100px;margin:0 auto;padding:0 20px 40px;display:grid;gap:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.grid-3{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.p-card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px}
.p-card .ph{height:120px;background:#eef1f5;border-radius:8px;margin-bottom:8px}

/* viewer */
.viewer-wrap{border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-top:10px;background:#0f1115}
#viewer{width:100%;height:360px;display:block}

/* buttons */
.btn{padding:10px 14px;border:1px solid #111;background:#111;color:#fff;border-radius:8px;cursor:pointer}
.btn.secondary{background:#f8f8f8;color:#111;border-color:#c8c8c8}
.btn[disabled]{opacity:.45;cursor:not-allowed}
.mt{margin-top:10px}
pre{background:#fff;border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto}
.total h3{margin-top:10px}
