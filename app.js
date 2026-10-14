// OfferPk App Factory dashboard. Public GitHub API only, no token.
// Uses ETag conditional requests (304s don't count toward the 60/hr limit) + localStorage cache.
const OWNER='OfferPk',API='https://api.github.com',SELF='app-factory-dashboard';
const DETAIL_TTL=10*60e3, REFRESH=60e3;
const LS=k=>{try{return JSON.parse(localStorage.getItem(k))}catch{return null}};
const SS=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch{}};
let rate={remaining:'?',reset:0}, limited=false;

async function gh(path){
  const key='gh:'+path, c=LS(key);
  if(limited&&c) return c.data;
  const h={'Accept':'application/vnd.github+json'}; if(c&&c.etag) h['If-None-Match']=c.etag;
  let r; try{ r=await fetch(API+path,{headers:h}); }catch(e){ if(c) return c.data; throw e; }
  rate={remaining:r.headers.get('x-ratelimit-remaining')??rate.remaining,reset:+r.headers.get('x-ratelimit-reset')||rate.reset};
  if(r.status===304&&c){c.t=Date.now();SS(key,c);return c.data;}
  if(r.status===403||r.status===429){limited=true; if(c) return c.data; throw new Error('rate');}
  if(!r.ok){ if(c) return c.data; return null; }
  const data=await r.json(); SS(key,{etag:r.headers.get('etag'),t:Date.now(),data}); return data;
}
const fresh=path=>{const c=LS('gh:'+path);return c&&Date.now()-c.t<DETAIL_TTL};

const pkt=s=>s?new Date(s).toLocaleString('en-GB',{timeZone:'Asia/Karachi',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:true})+' PKT':'';
function ago(s){const m=Math.round((Date.now()-new Date(s))/6e4);return m<1?'just now':m<60?m+'m ago':m<1440?Math.round(m/60)+'h ago':Math.round(m/1440)+'d ago'}
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const kind=r=>r.status!=='completed'?'running':r.conclusion==='success'?'success':['failure','timed_out','startup_failure'].includes(r.conclusion)?'failure':'none';
const label=n=>/android|apk/i.test(n)?'Android build':/page/i.test(n)?'Pages':/ci|test|lint/i.test(n)?'CI':n;

async function details(repo){
  const p=`/repos/${OWNER}/${repo.name}`;
  // refetch when push changed, cached data stale, or something still running
  const prev=LS('d:'+repo.name);
  const need=!prev||prev.pushed!==repo.pushed_at||!fresh(p+'/actions/runs?per_page=30')||prev.running;
  if(!need) return prev;
  const [commits,runs,pulls]=await Promise.all([
    gh(p+'/commits?per_page=1'), gh(p+'/actions/runs?per_page=30'), gh(p+'/pulls?state=open&per_page=100')]);
  const latest={}; for(const r of (runs&&runs.workflow_runs)||[]) if(!latest[r.name]) latest[r.name]=r;
  const wf=Object.values(latest).map(r=>({name:label(r.name),k:kind(r),url:r.html_url}));
  const apk=((runs&&runs.workflow_runs)||[]).find(r=>/android|apk/i.test(r.name)&&r.conclusion==='success');
  const c=commits&&commits[0];
  const d={pushed:repo.pushed_at,msg:c?c.commit.message.split('\n')[0]:'',ctime:c?c.commit.committer.date:repo.pushed_at,
    curl:c?c.html_url:'',wf,apk:apk?apk.html_url:'',prs:pulls?pulls.length:0,running:wf.some(w=>w.k==='running')};
  SS('d:'+repo.name,d); return d;
}

function card(repo,d,now){
  const badges=d.wf.length?d.wf.map(w=>`<a class="b ${w.k}" href="${esc(w.url)}" target="_blank">${w.k==='success'?'✓':w.k==='failure'?'✗':w.k==='running'?'●':'–'} ${esc(w.name)}</a>`).join(''):'<span class="b none">No workflows</span>';
  const demo=repo.has_pages?`<a href="https://offerpk.github.io/${esc(repo.name)}/" target="_blank">▶ Live demo</a>`:'<span class="dis">No live demo</span>';
  const apk=d.apk?`<a href="${esc(d.apk)}" target="_blank">📦 APK</a>`:'<span class="dis">No APK yet</span>';
  return `${now?'<span class="tag">⚡ NOW WORKING ON</span>':''}
  <h3><a href="${esc(repo.html_url)}" target="_blank">${esc(repo.name)}</a></h3>
  <p class="desc">${esc(repo.description||'')}</p>
  <div class="commit">📝 ${d.curl?`<a href="${esc(d.curl)}" target="_blank">${esc(d.msg)}</a>`:esc(d.msg||'—')}<time>${pkt(d.ctime)} · ${ago(d.ctime)}</time></div>
  <div class="badges">${badges}</div>
  <div class="links">${demo}${apk}<a href="${esc(repo.html_url)}/pulls" target="_blank">🔀 ${d.prs} open PR${d.prs==1?'':'s'}</a></div>`;
}

async function load(){
  limited=false;
  try{
    let repos=await gh(`/users/${OWNER}/repos?per_page=100&sort=pushed`);
    if(!repos) throw new Error('no data');
    repos=repos.filter(r=>!r.fork&&r.name!==SELF).sort((a,b)=>new Date(b.pushed_at)-new Date(a.pushed_at));
    const ds=[]; for(const r of repos) ds.push(await details(r).catch(()=>LS('d:'+r.name)||{wf:[],prs:0}));
    let pass=0,fail=0,run=0,prs=0;
    ds.forEach(d=>{prs+=d.prs||0;const b=(d.wf||[]).filter(w=>w.name!=='Pages');if(b.some(w=>w.k==='running'))run++;else if(b.some(w=>w.k==='failure'))fail++;else if(b.some(w=>w.k==='success'))pass++;});
    const set=(id,v)=>document.getElementById(id).textContent=v;
    set('s-apps',repos.length);set('s-pass',pass);set('s-fail',fail);set('s-run',run);set('s-pr',prs);
    const now=document.getElementById('now');
    if(repos[0]){now.innerHTML=card(repos[0],ds[0],true);now.classList.remove('hidden');}
    document.getElementById('grid').innerHTML=repos.slice(1).map((r,i)=>`<article class="card repo">${card(r,ds[i+1])}</article>`).join('');
    set('updated','Updated '+pkt(new Date().toISOString()));
  }catch(e){ console.error(e); }
  const n=document.getElementById('notice');
  if(limited||(rate.remaining!=='?'&&+rate.remaining<5)){
    n.textContent=`⚠ GitHub API rate limit reached (60 requests/hour for visitors). Showing cached data; live updates resume at ${pkt(new Date(rate.reset*1000).toISOString())}.`;
    n.classList.remove('hidden');
  } else n.classList.add('hidden');
  document.getElementById('rate').textContent=`API calls left this hour: ${rate.remaining}`;
}
document.getElementById('refresh').onclick=load;
load(); setInterval(load,REFRESH);
