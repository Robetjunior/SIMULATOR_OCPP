const http=require('http');
const fs=require('fs');
const path=require('path');
const base=__dirname;
const mime={'.html':'text/html','.css':'text/css','.js':'application/javascript','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{let url=decodeURIComponent(req.url.split('?')[0]);if(url==='/'||url==='') url='/index.html';const fp=path.join(base,url);fs.stat(fp,(err,st)=>{if(err||!st.isFile()){res.statusCode=404;res.end('Not Found');return;}const ext=path.extname(fp).toLowerCase();res.setHeader('Content-Type',mime[ext]||'application/octet-stream');fs.createReadStream(fp).pipe(res);});});
const PORT=process.env.PORT?Number(process.env.PORT):5510;
const HOST=process.env.HOST||'127.0.0.1';
server.listen(PORT,HOST,()=>{console.log(`PREVIEW_URL=http://${HOST}:${PORT}/`);});
