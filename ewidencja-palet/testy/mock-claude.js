// Atrapa platformy Claude (window.claude.use) do testów w przeglądarce — baza w pamięci.
// Dane startowe: window.__SEED = {couriers:{id:data}, transactions:{id:data}, meta:{id:data}} (ustaw przed załadowaniem).
(function(){
  const seed = window.__SEED || {};
  const S = window.__store = {couriers:{}, transactions:{}, meta:{}, ...JSON.parse(JSON.stringify(seed))};
  window.__writes = [];
  const subs = []; let seq = 0;
  const pend = new Set();
  function cmp(x,y){ return x<y?-1:x>y?1:0; }
  function q(coll, filters, ord, lim){
    filters = filters||[];
    return {
      where(f,op,v){ return q(coll,[...filters,[f,op,v]],ord,lim); },
      orderBy(f,d){ return q(coll,filters,[f,d||'asc'],lim); },
      limit(n){ return q(coll,filters,ord,n); },
      _run(){
        let docs = Object.entries(S[coll]||{}).map(([id,d])=>({id,d}));
        for(const [f,op,v] of filters){
          docs = docs.filter(x=>{ const a=x.d[f];
            return op==='=='?a===v: op==='!='?a!==v: op==='<'?a<v: op==='<='?a<=v: op==='>'?a>v: op==='>='?a>=v: true; });
        }
        if(ord){ docs.sort((a,b)=>{ const c=cmp(a.d[ord[0]],b.d[ord[0]]); return ord[1]==='desc'?-c:c; }); }
        else docs.sort((a,b)=>cmp(a.id,b.id));
        if(lim) docs = docs.slice(0,lim);
        return {docs: docs.map(x=>({id:x.id, exists:true, data:()=>JSON.parse(JSON.stringify(x.d))}))};
      },
      get(){ return Promise.resolve(this._run()); },
      onSnapshot(cb){ const s={coll, run:()=>cb(this._run())}; subs.push(s); setTimeout(s.run,0); return ()=>{ const i=subs.indexOf(s); if(i>-1) subs.splice(i,1); }; },
      doc(id){ return D(coll, id||('n'+(++seq))); },
      add(d){ const r=D(coll,'n'+(++seq)); return r.set(d).then(()=>r); },
    };
  }
  function fire(coll){ subs.filter(s=>s.coll===coll).forEach(s=>{ if(pend.has(s)) return; pend.add(s); setTimeout(()=>{ pend.delete(s); s.run(); },0); }); }
  function D(coll,id){ return {
    id,
    get(){ const d=(S[coll]||{})[id]; return Promise.resolve({id, exists:!!d, data:()=>d?JSON.parse(JSON.stringify(d)):undefined}); },
    set(d){ S[coll]=S[coll]||{}; S[coll][id]=JSON.parse(JSON.stringify(d)); __writes.push(['set',coll,id,d]); fire(coll); return Promise.resolve(); },
    update(d){ if(!(S[coll]||{})[id]) return Promise.reject(Object.assign(new Error('not found'),{code:'not_found'})); S[coll][id]={...S[coll][id],...JSON.parse(JSON.stringify(d))}; __writes.push(['update',coll,id,d]); fire(coll); return Promise.resolve(); },
    delete(){ if(S[coll]) delete S[coll][id]; __writes.push(['delete',coll,id]); fire(coll); return Promise.resolve(); },
    onSnapshot(cb){ const s={coll, run:()=>{ const d=(S[coll]||{})[id]; cb({id, exists:!!d, data:()=>d?JSON.parse(JSON.stringify(d)):undefined}); }}; subs.push(s); setTimeout(s.run,0); return ()=>{}; },
  }; }
  const db = { collection:c=>q(c), doc:p=>{ const [c,i]=p.split('/'); return D(c,i); } };
  window.__fire = fire;
  window.__downloads = [];
  const assets = { upload: async (blob)=>{ const id='a'+(++seq); return {id, url:'/_blob/'+id, sizeBytes:blob.size, contentType:blob.type}; }, list: async()=>({assets:[],usage:{}}), delete: async()=>{} };
  const downloads = { save: async (o)=>{ window.__downloads.push(o); } };
  window.claude = { use: async n => n==='db'?db : n==='downloads'?downloads : n==='assets'?assets : null };
})();
