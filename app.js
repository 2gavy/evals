const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const INDEX_PATTERN = /^[a-z][a-z0-9_-]{2,90}$/;
const K = 3;
const STORE = 'elastic-vector-workshop-sg-v3';
const steps = [
  ['Why', 'Start with the search task', 'Why: a vector is useful only when it helps someone find the right content. Begin with the person and the question, then compare retrieval methods.'],
  ['Project', 'Create a Vector Database project', 'Why: this Serverless project type supplies vector-oriented defaults, managed infrastructure and access to Elastic Inference Service.'],
  ['Mapping', 'Define text, vector and metadata fields', 'Why: the mapping determines which words get BM25 search, which content gets embedded and which fields support filters.'],
  ['Ingest', 'Index the food documents', 'Why: a document must be in the index before any retrieval method can find it. Ingest also generates embeddings for semantic_text.'],
  ['Keyword', 'Measure keyword search quality', 'Why: BM25 is the baseline for exact words and identifiers. Precision@3 and Recall@3 show which useful documents it finds; RR@3 and NDCG@3 show where they rank. Average RR across queries for MRR, then use the failures to guide improvement.'],
  ['Vector', 'Measure vector search quality', 'Why: vector search may find answers worded differently from the query. Compare its Precision@3, Recall@3, RR@3 and NDCG@3 with the keyword baseline using the same judgments; average RR across queries for MRR.'],
  ['Hybrid', 'Measure hybrid search quality', 'Why: RRF combines keyword and vector rankings. Compare hybrid with semantic search here: did fusion move the useful answer or improve Precision@3, Recall@3, RR@3 or NDCG@3? Evaluate all three methods across queries in the next step.'],
  ['Evaluate', 'Compare search methods, then improve the ranking', 'Why: keyword, vector and hybrid can rank the same answers differently. Evaluate them on the same judged questions, then test a boost where a useful result is found but buried.'],
  ['Improve', 'Boost a relevant result offline', 'Why: Q1 already retrieves the recipe, but ranks it third. Test a controlled recipe boost, then re-evaluate with the same judgments.'],
  ['Studio', 'Scale offline evaluation with Relevance Studio', 'Why: scenarios, judgments, strategies and benchmarks make the six-query offline comparison repeatable.'],
  ['Online', 'High offline scores, but users cannot find the recipe', 'Why: NDCG and MRR were high on six familiar queries, but demand changes after launch. A viral Z&V Cafe recipe exposes a search task the offline set missed.'],
  ['Improve again', 'Test, gate, and release the ranking change', 'Why: a promising offline score is only the start. Check the new strategy against the full judged set in CI, then test whether it helps real search users before rolling it out.']
];
let data, step=0, queryId='Q1', judgeQueryId='Q1', indexName='sg-food-vector-workshop', saved={}, labels={}, snippets={}, sectionByStep={}, showAllSections=false, viralRank=0;
let abSnapshot=null;
let viralActive=false;
const abState={intro:{qid:'Q2',a:'keyword',b:'vector'},evaluate:{qid:'Q2',a:'keyword',b:'vector'},online:{qid:'Q2',a:'keyword',b:'hybrid'}};
const studioState={qid:'Q1'};
const abModes={keyword:'Keyword · BM25',vector:'Semantic · vector',hybrid:'Hybrid · RRF'};

function saveState(){try{localStorage.setItem(STORE,JSON.stringify({step,queryId,indexName,sectionByStep}))}catch{}}
function status(message){$('#status').textContent=message}
function doc(id){return data.documents.find(d=>d.id===id)}
function query(id=queryId){return data.queries.find(q=>q.id===id)??(id===data.viralQuery?.id?data.viralQuery:undefined)}
function grade(qid,did){return Number(labels[qid]?.[did] ?? 0)}
function snippet(method,path,body){return `${method} ${path}${body?'\n'+JSON.stringify(body,null,2):''}`}
function source(d){return {title:d.title,content:d.content,category:d.category,status:d.status,click_count:d.click_count}}
function mapping(){return snippet('PUT',indexName,{mappings:{properties:{title:{type:'text'},content:{type:'text',copy_to:'semantic_content'},semantic_content:{type:'semantic_text',inference_id:data.model},category:{type:'keyword'},status:{type:'keyword'},click_count:{type:'long'}}}})}
function bulkRows(documents){return `POST ${indexName}/_bulk?refresh=wait_for\n${documents.flatMap(d=>[JSON.stringify({index:{_id:d.id}}),JSON.stringify(source(d))]).join('\n')}\n`}
function bulk(){return bulkRows(data.documents.filter(d=>d.initial))}
function searchBody(mode,text){const lexical={match:{content:text}};const semantic={match:{semantic_content:{query:text}}};let body={size:K,_source:['title','content','category','status']};if(mode==='keyword')body.query=lexical;if(mode==='vector')body.query=semantic;if(mode==='hybrid')body.retriever={rrf:{retrievers:[{standard:{query:lexical}},{standard:{query:semantic}}],rank_constant:60,rank_window_size:10}};return body}
function search(mode,qid=queryId){return snippet('GET',`${indexName}/_search`,searchBody(mode,query(qid).text))}
function titleWeightSearch(weight){return snippet('GET',`${indexName}/_search`,{size:K,_source:['title','content','category','status'],query:{multi_match:{query:query('Q1').text,fields:[weight===1?'title':`title^${weight}`,'content']}}})}
function studioStrategy(mode){return JSON.stringify(searchBody(mode,'{{ text }}'),null,2)}
function studioTitleWeightStrategy(weight){return JSON.stringify({size:K,_source:['title','content','category','status'],query:{multi_match:{query:'{{ text }}',fields:[weight===1?'title':`title^${weight}`,'content']}}},null,2)}
function studioRecipeBoostStrategy(){return JSON.stringify({size:K,query:{function_score:{query:{match:{content:'{{ text }}'}},functions:[{filter:{term:{category:'recipe'}},weight:8}],score_mode:'sum',boost_mode:'sum'}}},null,2)}
function studioRerankStrategy(){const body=searchBody('hybrid','{{ text }}');body.retriever={text_similarity_reranker:{retriever:body.retriever,field:'content',inference_id:'.rerank-v1-elasticsearch',inference_text:'{{ text }}',rank_window_size:10}};return JSON.stringify(body,null,2)}
function filtered(){return snippet('GET',`${indexName}/_search`,{size:K,_source:['title','content','status'],query:{bool:{must:[{match:{semantic_content:{query:query('Q6').text}}}],filter:[{term:{status:'current'}}]}}})}
function byov(){const other=`${indexName}-byov`;return [snippet('PUT',other,{mappings:{properties:{title:{type:'keyword'},vec:{type:'dense_vector',dims:3,similarity:'cosine'}}}}),`POST ${other}/_bulk?refresh=wait_for\n${JSON.stringify({index:{_id:'chicken-rice'}})}\n${JSON.stringify({title:'Hainanese chicken rice',vec:[1,0,0]})}\n${JSON.stringify({index:{_id:'roast-chicken-rice'}})}\n${JSON.stringify({title:'Roasted chicken rice',vec:[0.9,0.1,0]})}\n${JSON.stringify({index:{_id:'nasi-lemak'}})}\n${JSON.stringify({title:'Nasi lemak',vec:[0,1,0]})}\n`,snippet('GET',`${other}/_search`,{size:2,_source:['title'],knn:{field:'vec',query_vector:[1,0,0],k:2,num_candidates:3}})].join('\n\n')}
function code(title,value,copyLabel='Copy for Dev Tools'){const key=`s${Object.keys(snippets).length}`;snippets[key]=value;const destination=copyLabel==='Copy strategy body'?'studio':'console';return `<div class="code-head"><strong>${esc(title)}</strong><button class="secondary" data-copy="${key}" data-copy-target="${destination}">${esc(copyLabel)}</button></div><pre><code>${esc(value)}</code></pre>`}
function panel(title,html,variant='',action=''){return `<section class="panel ${variant}">${action?`<div class="panel-title-row"><h2>${title}</h2>${action}</div>`:`<h2>${title}</h2>`}${html}</section>`}
function callout(title,content,warning=false){return `<div class="callout ${warning?'warning':''}"><b>${title}</b><p>${content}</p></div>`}
function table(head,rows){return `<div class="table-scroll"><table><thead><tr>${head.map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`}
function metric(ids,qid){const gains=ids.slice(0,K).map(id=>2**grade(qid,id)-1);const relevant=Object.values(labels[qid]??{}).filter(g=>Number(g)>=2).length;const found=ids.slice(0,K).filter(id=>grade(qid,id)>=2).length;const first=ids.slice(0,K).findIndex(id=>grade(qid,id)>=2);const dcg=gains.reduce((sum,g,i)=>sum+g/Math.log2(i+2),0);const ideal=Object.values(labels[qid]??{}).map(Number).sort((a,b)=>b-a).slice(0,K).reduce((sum,g,i)=>sum+(2**g-1)/Math.log2(i+2),0);return {precision:found/K,recall:relevant?found/relevant:null,rr:first<0?0:1/(first+1),ndcg:ideal?dcg/ideal:null}}
const fmt=n=>n==null?'—':n.toFixed(3);
function abWorkbench(phase){
  const state=abState[phase];
  const choices=Object.entries(abModes).map(([value,label])=>`<option value="${value}">${esc(label)}</option>`).join('');
  const control=(arm,mode)=>phase==='online'?`<div class="improve-lane-title">${esc(abModes[mode])}</div>`:`<label>Search method<select id="ab-${arm}">${choices}</select></label>`;
  const numbered=phase==='evaluate';
  return `<div class="ab-workbench" id="ab-workbench" data-phase="${phase}">${numbered?'<h3 class="eval-step-heading"><span class="stage-number">1</span> Choose the search question</h3>':''}<div class="ab-toolbar"><label>Search question<select id="ab-query">${data.queries.map(q=>`<option value="${q.id}" ${q.id===state.qid?'selected':''}>${q.id} · ${esc(q.text)}</option>`).join('')}</select></label><span class="ab-source" id="ab-source">Loading captured Elasticsearch results…</span></div><p class="ab-task" id="ab-task"></p><p class="ab-ideal" id="ab-ideal"></p>${numbered?'<h3 class="eval-step-heading"><span class="stage-number">2</span> Compare the results and scores</h3>':''}<div class="ab-lanes"><section class="ab-lane"><div class="ab-lane-head"><span class="ab-arm">A</span>${control('a',state.a)}</div><div id="ab-results-a"></div></section><section class="ab-lane"><div class="ab-lane-head"><span class="ab-arm">B</span>${control('b',state.b)}</div><div id="ab-results-b"></div></section></div><p class="result-legend"><b>Guide</b> is the document type (instructions); <b>Current</b> is its status (active, not archived).</p><div class="ab-takeaway" id="ab-takeaway" aria-live="polite"></div></div>`
}
function methodPreview(mode){
  const methods=mode==='keyword'?['keyword']:mode==='vector'?['keyword','vector']:['vector','hybrid'];
  return `<div class="method-preview ${methods.length===1?'single':''}" id="method-preview" data-mode="${mode}"><div class="method-preview-head"><b>Results for ${esc(queryId)}</b><span>Captured Elasticsearch results · the answer key behind the metrics is explained in 08 Evaluate</span></div><div class="ab-lanes">${methods.map(method=>`<section class="ab-lane"><div class="method-lane-title">${esc(abModes[method])}</div><div data-preview-method="${method}"><p class="muted">Loading captured results…</p></div></section>`).join('')}</div>${methods.length>1?'<p class="result-legend"><b>Only changes are coloured on the right:</b> <span class="legend-up">green = moved up</span> · <span class="legend-down">amber = moved down</span> · <span class="legend-new">blue = entered top 3</span>. A coloured metric border means its value changed; unchanged results and metrics stay neutral.</p>':''}<p class="result-legend"><b>Guide</b> is the document type (instructions); <b>Current</b> is its status (active, not archived). Numeric relevance grades start in <b>08 Evaluate</b>.</p></div>`
}
async function renderMethodPreview(){
  const root=$('#method-preview');if(!root)return;
  const qid=queryId;
  try{
    await loadAbSnapshot();
    if(root!==$('#method-preview')||qid!==queryId)return;
    const baseline=root.dataset.mode==='vector'?'keyword':root.dataset.mode==='hybrid'?'vector':null;
    root.querySelectorAll('[data-preview-method]').forEach(lane=>{const method=lane.dataset.previewMethod;lane.innerHTML=abLane('',method,qid,'lesson',baseline&&method!==baseline?baseline:null)});
  }catch(error){if(root===$('#method-preview'))root.innerHTML=callout('Captured example unavailable',esc(error.message),true)}
}
function idealDocumentIds(qid){
  const judgments=Object.entries(labels[qid]??{});
  const best=Math.max(0,...judgments.map(([,value])=>Number(value)));
  return best>=2?judgments.filter(([,value])=>Number(value)===best).map(([id])=>id):[]
}
function abResultCard(hit,rank,qid,showGrade,highlightIdeal=false,previousHits=null){
  const d=doc(hit.id),rating=grade(qid,hit.id);
  const ideal=highlightIdeal&&idealDocumentIds(qid).includes(hit.id);
  const prior=previousHits?.findIndex(other=>other.id===hit.id)??-1;
  const movement=previousHits?(prior<0?'new':rank<prior+1?'up':rank>prior+1?'down':''):'';
  const movementText=movement==='new'?'New in top 3':movement==='up'?`↑ from #${prior+1}`:movement==='down'?`↓ from #${prior+1}`:'';
  const type={guide:'Guide',recipe:'Recipe',reference:'Reference',menu:'Menu'}[d?.category]??'Document';
  const version=d?.status==='archived'?'Archived':'Current';
  return `<article class="ab-result ${ideal?'ideal-result':''} ${movement?'rank-'+movement:''}"><div class="ab-result-top"><span class="ab-rank">#${rank} · ${esc(hit.id)}</span><span class="ab-type">${type} · ${version}</span></div><h3>${esc(d?.title??'Unknown document')}</h3>${movementText?`<span class="movement-badge">${movementText}</span>`:''}${ideal?`<span class="ideal-badge">${rank===1?'Ideal answer · already #1':'Ideal answer · move up'}</span>`:''}<p>${esc(d?.content??'')}</p><div class="ab-result-foot"><span>Elasticsearch rank score ${hit.score==null?'—':esc(Number(hit.score).toFixed(3))}</span>${showGrade?`<strong>Relevance grade ${rating}/3</strong>`:''}</div></article>`
}
function abLane(arm,mode,qid,phase,compareToMode=null){
  const hits=abSnapshot.results[qid][mode],m=metric(hits.map(h=>h.id),qid);
  const showScores=phase==='online'||phase==='lesson'||phase==='evaluate';
  const previousHits=compareToMode?abSnapshot.results[qid][compareToMode]:null;
  const previous=previousHits?metric(previousHits.map(h=>h.id),qid):null;
  const metricTile=(label,key)=>{const change=previous?m[key]>previous[key]+1e-9?'better':m[key]<previous[key]-1e-9?'worse':'':'';return `<span class="${change?'metric-'+change:''}">${label} <b>${fmt(m[key])}</b></span>`};
  const metrics=showScores?`<div class="ab-metric-label">Offline quality scores · top 3</div><div class="ab-metrics">${metricTile('Precision@3','precision')}${metricTile('Recall@3','recall')}${metricTile('RR@3','rr')}${metricTile('NDCG@3','ndcg')}</div>`:'';
  const highlightIdeal=phase==='online'||phase==='evaluate'||step===0;
  const showGrades=phase==='online'||phase==='evaluate';
  return `<div class="ab-count">${hits.length} returned result${hits.length===1?'':'s'} · ${esc(abModes[mode])}</div><div class="ab-cards">${hits.length?hits.map((hit,i)=>abResultCard(hit,i+1,qid,showGrades,highlightIdeal,previousHits)).join(''):'<p class="muted">No results returned.</p>'}</div>${metrics}`
}
function comparisonTakeaway(qid,beforeMode,afterMode){
  const before=abSnapshot.results[qid][beforeMode],after=abSnapshot.results[qid][afterMode];
  const rank=(hits,id)=>{const i=hits.findIndex(hit=>hit.id===id);return i<0?'outside top 3':`#${i+1}`};
  const useful=Object.entries(labels[qid]).filter(([,value])=>Number(value)>=2).map(([id])=>id);
  const moved=useful.filter(id=>rank(before,id)!==rank(after,id)).map(id=>`${id} ${rank(before,id)} → ${rank(after,id)}`);
  const a=metric(before.map(hit=>hit.id),qid),b=metric(after.map(hit=>hit.id),qid);
  const names={precision:'Precision@3',recall:'Recall@3',rr:'RR@3',ndcg:'NDCG@3'};
  const changed=Object.entries(names).filter(([key])=>Math.abs((a[key]??0)-(b[key]??0))>1e-9).map(([key,name])=>`${name} ${fmt(a[key])} → ${fmt(b[key])}`);
  return `<b>Useful results:</b> ${moved.length?esc(moved.join('; ')):'same visible ranks'}. <b>Offline metrics:</b> ${changed.length?esc(changed.join('; ')):'all four tie'}.`;
}
function abLesson(qid){return {
  Q1:'D01 is the usable recipe. Compare its rank; moving irrelevant pages without moving D01 does not improve this task.',
  Q2:'“Brinjal” and “eggplant” describe the same food. Check whether each method returns only the keyword page D19 or also finds useful recipes D04 and D20. Even a method that finds them may still rank D19 first.',
  Q3:'D06 is the mee goreng recipe. Check whether each method ranks the usable cooking steps above incidental noodle mentions.',
  Q4:'This task needs the exact RC-123 model. Compare D09 and D22 with the wrong-model documents; meaning alone is not a substitute for checking identifiers.',
  Q5:'The safe sauce D11 can rank first while the peanut sauce D12 still appears. Inspect every visible result for the allergen risk.',
  Q6:'D14 is the current menu and D13 is archived. A good top hit does not remove an outdated result below it.'
}[qid]}
async function loadAbSnapshot(){
  if(abSnapshot)return abSnapshot;
  const response=await fetch('./cached-results.json');
  if(!response.ok)throw Error(`Captured results are unavailable (HTTP ${response.status}).`);
  const snapshot=await response.json();
  if(snapshot.index!==data.index||snapshot.documentCount!==data.documents.filter(d=>d.initial).length)throw Error('Captured results do not match this workshop dataset.');
  for(const q of data.queries){
    if(snapshot.queryTexts?.[q.id]!==q.text)throw Error(`Captured ${q.id} query does not match this workshop.`);
    for(const mode of Object.keys(abModes)){
      const hits=snapshot.results?.[q.id]?.[mode];
      if(!Array.isArray(hits)||hits.length>K||hits.some(h=>!doc(h.id)||!(h.score===null||typeof h.score==='number'&&Number.isFinite(h.score)))||new Set(hits.map(h=>h.id)).size!==hits.length)throw Error(`Captured ${q.id} ${mode} results are invalid.`);
    }
  }
  abSnapshot=snapshot;return snapshot
}
async function loadFixedResults(){
  const baseline=await loadAbSnapshot();
  const response=await fetch('./improved-results.json');
  if(!response.ok)throw Error(`Captured improvement examples are unavailable (HTTP ${response.status}).`);
  const improved=await response.json();
  if(improved.index!==data.index||improved.documentCount!==data.documents.length)throw Error('Captured improvements do not match this dataset.');
  saved={};
  for(const q of data.queries){
    saved[q.id]={};
    for(const mode of Object.keys(abModes))saved[q.id][mode]={hits:baseline.results[q.id][mode],source:'fixed'};
  }
  saved.Q1.recipeBoost={hits:improved.results.offline.Q1.recipeBoost,source:'fixed'};
  saved.viral={hybrid:{hits:improved.results.online.hybridTop5,source:'fixed'},hybridClick:{hits:improved.results.online.hybridClickTop5,source:'fixed'}};
  viralRank=Number(improved.results.online.hybridD08Rank);
  if(!Number.isInteger(viralRank)||viralRank<=5)throw Error('Captured hybrid rank for D08 is invalid.');
  for(const q of data.queries)saved[q.id].hybridClick={hits:improved.results.crossQuery[q.id],source:'fixed'};
  for(const [qid,modes] of Object.entries(saved))for(const [mode,item] of Object.entries(modes)){
    const hits=item.hits;
    if(!Array.isArray(hits)||hits.length>(qid==='viral'?5:K)||hits.some(hit=>!doc(hit.id)||typeof hit.score!=='number'||!Number.isFinite(hit.score))||new Set(hits.map(hit=>hit.id)).size!==hits.length)throw Error(`Captured ${qid} ${mode} results are invalid.`);
  }
}
async function renderAbWorkbench(){
  const root=$('#ab-workbench');if(!root)return;
  const phase=root.dataset.phase,state=abState[phase];
  try{
    await loadAbSnapshot();
    if(root!==$('#ab-workbench'))return;
    const q=query(state.qid),date=new Date(abSnapshot.capturedAt).toLocaleDateString();
    $('#ab-source').textContent=`Captured from Elasticsearch · ${date} · six fixed queries`;
    $('#ab-task').innerHTML=`<b>User task:</b> ${esc(q.task)}`;
    const ideals=idealDocumentIds(state.qid);
    const visibleIds=new Set([...abSnapshot.results[state.qid][state.a],...abSnapshot.results[state.qid][state.b]].map(hit=>hit.id));
    const absent=ideals.filter(id=>!visibleIds.has(id));
    const idealNote=absent.length===ideals.length?`No card is highlighted: ${absent.map(esc).join(' and ')} ${absent.every(id=>!doc(id)?.initial)?absent.length===1?'was not indexed yet':'were not indexed yet':absent.length===1?'is absent from both top-three lists':'are absent from both top-three lists'}.`:absent.length?`${absent.map(esc).join(' and ')} ${absent.length===1?'is':'are'} absent from both top-three lists.`:'The highlighted cards show where they appear in each list.';
    $('#ab-ideal').hidden=phase==='online';
    if(phase!=='online')$('#ab-ideal').innerHTML=`<b>Ideal answer${ideals.length===1?'':'s'} to rank high:</b> ${ideals.map(id=>`${esc(id)} · ${esc(doc(id)?.title??'Unknown document')}${doc(id)?.initial?'':' <em>(not indexed yet)</em>'}`).join(' · ')}. ${idealNote}`;
    $('#ab-results-a').innerHTML=abLane('A',state.a,state.qid,phase);
    $('#ab-results-b').innerHTML=abLane('B',state.b,state.qid,phase);
    $('#ab-takeaway').innerHTML=`<b>${phase==='evaluate'?'What these scores tell you':'What to notice'}</b><p>${esc(state.a===state.b?'Both sides use the same search method, so their rankings match. Choose different methods to see what changes.':phase==='evaluate'?evalDiagnosis(state.qid):abLesson(state.qid))}</p>${phase==='online'?'<p>The score strip shows <b>offline relevance metrics</b> from judgments. The practice run below tests fictional clicks and task completion. Side-by-side inspection itself is not a randomized user A/B test.</p>':'<p>These captured Elasticsearch results and fixed relevance judgments give everyone the same metrics.</p>'}<p>Compare document ranks and content. Raw Elasticsearch <code>_score</code> values use different scales across search methods.</p>`;
    if(phase==='evaluate'){const judgments=$('#judge-details');if(judgments){const wasOpen=judgments.open;judgments.outerHTML=labelEditor();$('#judge-details').open=wasOpen}}
  }catch(error){if(root===$('#ab-workbench'))root.querySelector('#ab-takeaway').innerHTML=callout('Comparison unavailable',esc(error.message),true)}
}
function wireAbWorkbench(){
  const root=$('#ab-workbench');if(!root)return;
  const phase=root.dataset.phase,state=abState[phase];
  if(phase!=='online'){root.querySelector('#ab-a').value=state.a;root.querySelector('#ab-b').value=state.b}
  const update=()=>{state.qid=root.querySelector('#ab-query').value;if(phase!=='online'){state.a=root.querySelector('#ab-a').value;state.b=root.querySelector('#ab-b').value}renderAbWorkbench()};
  root.querySelector('#ab-query').onchange=update;
  if(phase!=='online'){root.querySelector('#ab-a').onchange=update;root.querySelector('#ab-b').onchange=update}
  renderAbWorkbench()
}
function metricBreakdown(ids,qid){
  const positions=Array.from({length:K},(_,i)=>({id:ids[i]??null,grade:ids[i]?grade(qid,ids[i]):0}));
  const relevantFound=positions.filter(p=>p.id&&p.grade>=2).length;
  const relevantTotal=Object.values(labels[qid]??{}).filter(g=>Number(g)>=2).length;
  const first=positions.findIndex(p=>p.id&&p.grade>=2);
  const ideal=Object.entries(labels[qid]??{}).map(([id,g])=>({id,grade:Number(g)})).sort((a,b)=>b.grade-a.grade).slice(0,K);
  const contribution=(g,i)=>(2**g-1)/Math.log2(i+2);
  const actualDcg=positions.reduce((sum,p,i)=>sum+contribution(p.grade,i),0);
  const idealDcg=ideal.reduce((sum,p,i)=>sum+contribution(p.grade,i),0);
  const ranked=positions.map((p,i)=>`<span class="calc-position">#${i+1} ${p.id?esc(p.id):'no result'} · grade ${p.grade}</span>`).join('');
  const idealRanks=ideal.map(p=>`${esc(p.id)} (grade ${p.grade})`).join(' → ');
  const actualTerms=positions.map((p,i)=>`${2**p.grade-1}/log₂(${i+2})`).join(' + ');
  const idealTerms=ideal.map((p,i)=>`${2**p.grade-1}/log₂(${i+2})`).join(' + ');
  return `<section class="calculation" aria-label="Metric calculation for ${esc(qid)}"><h3>How these scores were calculated</h3><p class="calc-ranking">Returned order: ${ranked}</p><p>These metrics use the <b>rank order</b> and the fixed relevance grades, not the raw Elasticsearch <code>_score</code>. Grades 2–3 count as <b>relevant</b> for Precision, Recall and RR. Grade 1 is related but insufficient; NDCG still gives it a small gain.</p><div class="calc-grid"><div><b>Precision@3 = ${relevantFound} ÷ ${K} = ${fmt(relevantFound/K)}</b><small>${relevantFound} relevant result${relevantFound===1?'':'s'} in the first ${K} positions.</small></div><div><b>Recall@3 = ${relevantFound} ÷ ${relevantTotal} = ${fmt(relevantTotal?relevantFound/relevantTotal:null)}</b><small>${relevantFound} found out of ${relevantTotal} known relevant source document${relevantTotal===1?'':'s'}, including any not yet indexed.</small></div><div><b>RR@3 = ${first<0?'0 (no relevant result in top 3)':`1 ÷ ${first+1} = ${fmt(1/(first+1))}`}</b><small>Use only the rank of the first relevant result.</small></div><div><b>NDCG@3 = ${fmt(actualDcg)} ÷ ${fmt(idealDcg)} = ${fmt(idealDcg?actualDcg/idealDcg:null)}</b><small>Compare the graded ranking with the best possible order.</small></div></div><p class="calc-detail"><b>NDCG working:</b> each grade earns <code>2^grade − 1</code> points, divided by <code>log₂(rank + 1)</code>. Actual DCG = ${actualTerms} = ${fmt(actualDcg)}. Ideal order from the judgment list: ${idealRanks||'no graded documents'}. Ideal DCG = ${idealTerms||'0'} = ${fmt(idealDcg)}.</p></section>`
}
function observed(qid,mode){const item=saved[qid]?.[mode];return item?metric(item.hits.map(h=>h.id),qid):null}
function evaluation(){
  const modes=['keyword','vector','hybrid'];
  const cacheNote='<p class="muted">All 18 rankings use the same captured Elasticsearch runs and fixed relevance grades.</p>';
  const rows=data.queries.map(q=>[`<div class="query-cell"><strong>${q.id} · ${esc(q.text)}</strong><small>Task: ${esc(q.task)}</small></div>`,...modes.map(mode=>{const m=observed(q.id,mode);return m?`P ${fmt(m.precision)} · R ${fmt(m.recall)}<br>RR ${fmt(m.rr)} · NDCG ${fmt(m.ndcg)}`:'<span class="muted">No response</span>'})]);
  const complete=data.queries.filter(q=>modes.every(mode=>saved[q.id]?.[mode]));
  const mrrSummary=complete.length?`<div class="eval-mrr-strip">${modes.map(mode=>{const values=complete.map(q=>observed(q.id,mode).rr);return `<div><small>${esc(abModes[mode])} · MRR@3</small><b>${fmt(values.reduce((sum,n)=>sum+n,0)/values.length)}</b></div>`}).join('')}</div><p class="result-legend">Average RR across the same ${complete.length} complete question${complete.length===1?'':'s'}; inspect individual failures below.</p>`:'';
  const mrr=complete.length?modes.map(mode=>{const terms=complete.map(q=>observed(q.id,mode).rr);const average=terms.reduce((sum,n)=>sum+n,0)/complete.length;return `<p><b>${mode[0].toUpperCase()+mode.slice(1)} MRR@3:</b> (${terms.map((n,i)=>`${complete[i].id}: ${fmt(n)}`).join(' + ')}) ÷ ${complete.length} = <b>${fmt(average)}</b></p>`}).join(''):'<p>No MRR@3 result yet. Measure all three methods for at least one query.</p>';
  const metricHelp=`<details class="calculation-disclosure"><summary>Read the metrics</summary><p>Precision@3 asks how many of three positions are useful. Recall@3 asks how many known relevant documents were found, including relevant source documents not yet indexed. RR@3 rewards finding the first useful result early. NDCG@3 uses graded relevance and position. MRR@3 averages RR@3 across the same query set.</p></details>`;
  const q1Vector=saved.Q1?.vector?.hits;
  const worked=q1Vector?`<details class="calculation-disclosure"><summary>Show a worked Q1 calculation</summary>${metricBreakdown(q1Vector.map(hit=>hit.id),'Q1')}</details>`:'';
  return cacheNote+mrrSummary+table(['Query','Keyword','Vector','Hybrid'],rows)+metricHelp+worked+`<details class="calculation-disclosure"><summary>Show MRR@3 calculation</summary><section class="calculation"><h3>MRR@3 results</h3><div class="mrr-results">${mrr}</div><h3 class="mrr-method-title">How MRR@3 is calculated</h3><p>MRR means <b>mean reciprocal rank</b>. Take each query’s RR@3, add them, then divide by the number of queries. For a fair comparison, include only queries with keyword, vector and hybrid responses all measured. Complete queries so far: <b>${complete.length}</b>.</p></section></details>`
}
function evalDiagnosis(qid){
  const entries=Object.fromEntries(Object.keys(abModes).map(mode=>[mode,saved[qid]?.[mode]]));
  const lists=Object.values(entries).filter(Boolean).flatMap(item=>item.hits.map(hit=>hit.id));
  if(!lists.length)return 'The captured rankings are unavailable. Reload the workshop to inspect the fixed example.';
  if(qid==='Q3')return 'D06 gives the mee goreng steps. It ranks first in these captured lists; check whether other visible results are useful before treating the query as solved.';
  if(qid==='Q5')return lists.includes('D12')?'D12 contains peanuts and is visible. A safe first result does not make the whole list safe; inspect all shown results and test an allergen filter.':'D12 is absent from these top-three lists. Check more results and related queries before treating the allergen risk as resolved.';
  if(qid==='Q6')return lists.includes('D13')?'D13 is archived but still visible. Filter to current documents before ranking, then remeasure.':'D13 is absent from these top-three lists. Verify the current-status filter on more queries and beyond rank three.';
  if(qid==='Q2'){
    const keyword=observed(qid,'keyword'),vector=observed(qid,'vector');
    return keyword&&vector&&keyword.recall<vector.recall?'Vector retrieves more known relevant brinjal/eggplant documents than keyword. Inspect D04 and D20, then check whether the keyword page D19 still ranks above them.':'Look for a vocabulary gap between “brinjal” and “eggplant.” Compare the actual documents and grades before changing synonyms or ranking.';
  }
  if(qid==='Q4')return 'Check that the highest-ranked instructions are for the exact RC-123 model. A semantically similar page for another model is not the right answer.';
  return 'Compare D01 and D17 with the search-tag decoys D02 and D18. If the useful recipe is found but ranks low behind reference pages, test a controlled recipe boost; if it is missing, inspect candidate retrieval first.';
}
function evalDiagnosisCards(){
  const m=(qid,mode)=>observed(qid,mode);
  const findings=[
    ['Q1 · Chicken rice','Boost ranking',`Keyword RR@3 ${fmt(m('Q1','keyword').rr)}; vector RR@3 ${fmt(m('Q1','vector').rr)}.`, 'D01 is found but sits below search-tag pages in keyword. The offline Improve step tests a recipe ranking boost.'],
    ['Q2 · Brinjal','Vocabulary',`Keyword Recall@3 ${fmt(m('Q2','keyword').recall)}; vector Recall@3 ${fmt(m('Q2','vector').recall)}.`, 'Keyword misses eggplant and aubergine recipes. Test synonyms or a controlled rewrite.'],
    ['Q3 · Mee goreng','Result noise',`Keyword Recall@3 ${fmt(m('Q3','keyword').recall)}; vector Recall@3 ${fmt(m('Q3','vector').recall)}.`, 'D06 ranks first, but inspect the other cards for noise. Good RR does not mean every result is useful.'],
    ['Q4 · RC-123','Exact identifier',`Keyword Recall@3 ${fmt(m('Q4','keyword').recall)}; vector Recall@3 ${fmt(m('Q4','vector').recall)}.`, 'Check other model numbers before assuming semantic search handles exact IDs reliably.'],
    ['Q5 · Peanut-free sauce','Safety',`Hybrid NDCG@3 ${fmt(m('Q5','hybrid').ndcg)}, but D12 contains peanuts.`, 'A safe first result does not make every visible result safe. Test a rule or filter.'],
    ['Q6 · Current menu','Freshness',`Hybrid NDCG@3 ${fmt(m('Q6','hybrid').ndcg)}, but archived D13 is visible.`, 'Filter current status, then re-evaluate.']
  ];
  return `<div class="eval-findings">${findings.map(([title,kind,signal,next],i)=>`<article class="eval-finding ${i===0?'eval-finding-worked':''}" ${i===0?'role="button" tabindex="0" data-step="8" aria-label="Open 09 Improve: Q1 Boost ranking"':''}><div><strong>${esc(title)}</strong><span>${esc(kind)}</span></div>${i===0?'<span class="eval-worked-badge">Open worked example in 09 Improve →</span>':''}<p class="eval-signal">${esc(signal)}</p><p>${esc(next)}</p></article>`).join('')}</div>`;
}
function evalOtherGaps(){
  return `<aside class="eval-other-gaps"><strong>Other gaps to check · including the embedding model</strong><p><b>If a relevant document is missing from vector results:</b> check that it was indexed and its text extracted correctly, then inspect chunks, filters and candidate depth. If vector search still misses indexed answers across many queries in the same language or domain, test whether the embedding model fits that content.</p><p><b>Test it fairly:</b> compare models on the same judged queries and K. Re-embed and reindex documents with the candidate model, use it for queries too, then check relevance, latency and cost. Q2's vector search succeeds, so that query alone does not prove a model problem.</p></aside>`;
}
function expertReviewCard(){
  return `<aside class="expert-review" aria-label="Expert review before offline evaluation"><div class="expert-review-heading"><span>Before these scores</span><strong>Bring in SMEs and expert evaluators</strong></div><div class="expert-review-roles"><div><b>SME · define relevance</b><p>Confirm each user's task, what a useful answer must contain, and the 0–3 grading rules.</p></div><div><b>Expert evaluators · judge results</b><p>Grade pooled query–document pairs. Have a second reviewer check uncertain or high-impact cases; resolve disagreements with the SME.</p></div><div><b>Then calculate</b><p>Freeze the reviewed judgments (qrels). Precision, Recall, RR, MRR and NDCG use these grades.</p></div></div><small>For this guided workshop, the judgments are already filled in so everyone sees the same baseline.</small></aside>`;
}
function evaluateContent(){
  return panel('Which search strategy needs a ranking change?',`<p>Keyword, vector and hybrid are three ways to search the same documents. Compare their results against the <b>same judged questions</b>. If a useful document is found but buried, test a ranking boost on that strategy. If it is missing, fix retrieval first; a boost cannot rank a document that was not found.</p>${expertReviewCard()}<p class="result-legend"><b>Relevance grades:</b> 0 = irrelevant · 1 = related · 2 = partly useful · 3 = direct answer. Grades 2 and 3 count as useful for Precision, Recall and RR; NDCG uses all four levels.</p><section class="eval-phase"><h3 class="eval-step-heading"><span class="stage-number">1</span> Compare keyword, vector and hybrid</h3><p>Use all six questions, not just one favourable example. MRR@3 averages the first useful result's rank across them; inspect each row as well as the average.</p>${evaluation()}</section><section class="eval-phase"><h3 class="eval-step-heading"><span class="stage-number">2</span> Choose what to improve</h3><p>The metrics show where a method struggles; the task and returned documents show why. Some gaps need retrieval, filters or data fixes. For a found-but-buried answer, test a boost and re-evaluate on the same questions.</p>${evalDiagnosisCards()}${evalOtherGaps()}<div class="eval-improve-bridge"><strong>Next: boost Q1 keyword ranking</strong><span>Keyword finds recipe D01 at #3, while vector and hybrid already put it at #1. Improve tests a boost on the keyword strategy, then Studio checks that strategy across the judged set before the later online event.</span></div>${labelEditor()}</section>`,'accent');
}
const improveNames={keyword:'Keyword · BM25',recipeBoost:'Keyword · recipe boost',hybridClick:'Hybrid · guarded click rescore'};
function improveLane(mode,qid){
  const item=saved[qid]?.[mode];
  if(!item)return `<p class="ab-count">Captured results are unavailable.</p>`;
  const m=observed(qid,mode),hits=item.hits;
  return `<div class="ab-count">Captured Elasticsearch run · ${hits.length} result${hits.length===1?'':'s'}</div><div class="ab-cards">${hits.length?hits.map((hit,i)=>abResultCard(hit,i+1,qid,true,true)).join(''):'<p class="muted">No results returned.</p>'}</div><div class="ab-metric-label">Offline quality scores · top 3</div><div class="ab-metrics"><span>Precision@3 <b>${fmt(m.precision)}</b></span><span>Recall@3 <b>${fmt(m.recall)}</b></span><span>RR@3 <b>${fmt(m.rr)}</b></span><span>NDCG@3 <b>${fmt(m.ndcg)}</b></span></div>`;
}
function improveComparison(qid,a,b){
  const lane=(arm,mode)=>`<section class="ab-lane"><div class="ab-lane-head"><span class="ab-arm">${arm}</span><div class="improve-lane-title">${esc(improveNames[mode])}</div></div><div id="view-${mode}">${improveLane(mode,qid)}</div></section>`;
  return `<div class="ab-lanes improve-lanes">${lane('A',a)}${lane('B',b)}</div>`;
}
function viralSearchRequest(weight=0,hybrid=false){
  const lexical=weight?{multi_match:{query:data.viralQuery.text,fields:[weight===1?'title':`title^${weight}`,'content']}}:{match:{content:data.viralQuery.text}};
  const semantic={match:{semantic_content:{query:data.viralQuery.text}}};
  const body={size:K,_source:['title','content','category','status']};
  if(hybrid)body.retriever={rrf:{retrievers:[{standard:{query:lexical}},{standard:{query:semantic}}],rank_constant:60,rank_window_size:10}};
  else body.query=lexical;
  return snippet('GET',`${indexName}/_search`,body);
}
function crossQueryCheck(){
  const summarize=m=>`P ${fmt(m.precision)} · R ${fmt(m.recall)} · RR ${fmt(m.rr)} · NDCG ${fmt(m.ndcg)}`;
  return table(['Original offline query','Hybrid baseline','Hybrid + click rescore'],data.queries.map(q=>[`${q.id} · ${esc(q.text)}`,summarize(observed(q.id,'hybrid')),summarize(observed(q.id,'hybridClick'))]));
}
function improveContent(){
  const before=observed('Q1','keyword'),after=observed('Q1','recipeBoost');
  const request=snippet('GET',`${indexName}/_search`,{size:3,_source:['title','content','category','status'],query:{function_score:{query:{match:{content:query('Q1').text}},functions:[{filter:{term:{category:'recipe'}},weight:8}],score_mode:'sum',boost_mode:'sum'}}});
  return panel('Q1 · boost a useful recipe to the top',`<p>The offline keyword result already finds D01, but it sits at #3 behind search-tag pages D02 and D18. This is a <b>ranking</b> problem. Keep all candidates eligible and add a score boost to documents tagged <code>recipe</code>.</p><div class="improve-check"><b>Hypothesis</b><span>A recipe-type boost of +8 should move D01 to #1 without removing D02 and D18. The weight is a candidate chosen for this workshop, not a default to apply to every query.</span></div><details class="improve-rerun"><summary>Optional: run the candidate in Dev Tools</summary>${code('Q1 · boost recipe ranking',request)}</details>${improveComparison('Q1','keyword','recipeBoost')}<p class="result-legend">RR@3 ${fmt(before.rr)} → ${fmt(after.rr)}; NDCG@3 ${fmt(before.ndcg)} → ${fmt(after.ndcg)}. Precision@3 and Recall@3 remain ${fmt(after.precision)} and ${fmt(after.recall)}: D01 moves up, but the same relevant documents are found within the top three.</p><p><b>Decision:</b> compare the same judgments and inspect the cards. A broad recipe boost may promote unrelated recipes on other searches, so test more recipe queries and check regressions before applying it beyond this Q1 experiment. Scale the comparison in Studio next.</p>`,'accent');
}
function labelEditor(){
  const byQuery=data.queries.map(q=>{
    const shown=new Set([...Object.keys(q.labels),...['keyword','vector','hybrid'].flatMap(mode=>(saved[q.id]?.[mode]?.hits??[]).map(hit=>hit.id))]);
    const documents=data.documents.filter(d=>shown.has(d.id));
    return `<details class="eval-judgment-query"><summary>${esc(q.id)} · ${esc(q.text)}</summary><p><b>Task:</b> ${esc(q.task)}</p>${table(['ID','Document','Grade'],documents.map(d=>[d.id,esc(d.title),String(grade(q.id,d.id))]))}</details>`
  }).join('');
  return `<details id="judge-details"><summary>Optional: inspect the fixed relevance judgments</summary><p>Grades 0–3 are the same for every participant. Grades 2–3 count as relevant for Precision, Recall and RR; NDCG uses all grades.</p>${byQuery}</details>`
}
function studioVisualContent(){
  const flow=`<p class="studio-flow-intro">Treat the original six queries as an offline search test suite. When later online behaviour reveals a new gap, add that observed search to a future offline set.</p><div class="flow studio-flow"><div><b>1 · Scenarios</b><small><strong>What will someone search for?</strong><br>Each test case holds a query and user task.</small></div><div><b>2 · Judgments</b><small><strong>Which documents answer it?</strong><br>Grade query–document pairs from 0 to 3.</small></div><div><b>3 · Strategies</b><small><strong>How will we search?</strong><br>Save keyword, vector, hybrid and candidate queries.</small></div><div><b>4 · Benchmark</b><small><strong>Which strategy works better?</strong><br>Run them at the same K and inspect individual failures.</small></div></div>`;
  return panel('Run the initial six-query offline benchmark',`${flow}<section class="studio-phase"><h3><span class="stage-number">1</span> Set up scenarios and judgments</h3><div class="studio-config"><span><b>Index pattern</b><code>${esc(indexName)}</code></span><span><b>Rating scale</b>0–3</span><span><b>Search parameter</b><code>text</code></span></div>${studioScenarioWorkbench()}<p><b>Who reviews this?</b> The SME approves the task and grading rubric; expert evaluators enter the query–document grades and flag disagreements. The SME adjudicates disputed or high-impact examples. The cards here show the reviewed workshop judgments. A zero on an unrated Studio card may only be its slider default, so confirm each grade was saved.</p></section><section class="studio-phase"><h3><span class="stage-number">2</span> Save strategies and benchmark</h3><p>Use <code>{{ text }}</code> as the scenario parameter. Run the same six scenarios with the same K for every strategy. Compare the actual results, then MRR and NDCG for order, Recall for missed answers and Precision for noise. Studio counts grade 1 as relevant in its binary metrics; this page uses grade 2 or higher, so its Precision and Recall can differ.</p><div class="studio-grid"><section class="studio-card"><h4>Keyword baseline</h4>${code('Keyword strategy',studioStrategy('keyword'),'Copy strategy body')}</section><section class="studio-card"><h4>Semantic vector</h4>${code('Vector strategy',studioStrategy('vector'),'Copy strategy body')}</section><section class="studio-card"><h4>Hybrid RRF</h4>${code('Hybrid strategy',studioStrategy('hybrid'),'Copy strategy body')}</section><section class="studio-card"><h4>Q1 recipe boost</h4>${code('Recipe-boost strategy',studioRecipeBoostStrategy(),'Copy strategy body')}</section></div><p>In your own Studio workspace, run the six-query baseline, then a Q1-only benchmark comparing keyword with the recipe boost. Review failures and unrated results.</p><p>Keep the six-query benchmark as your offline baseline. Add the Q1 recipe-boost candidate as another strategy and compare it on recipe tasks; it must not silently replace guide or menu searches. Later online traffic supplies new cases for the next version of this test set.</p></section>`,'accent');
}
const studioTerms={Q1:['chicken rice','Hainanese','white chicken','poach'],Q2:['brinjal','eggplant','aubergine','sambal'],Q3:['mee goreng','noodles','stir-fry'],Q4:['RC-123','rice cooker','RC-999'],Q5:['satay sauce','peanut-free','peanut'],Q6:['Rasa Corner','lunch menu','current','archived']};
function studioScenarioWorkbench(){
  return `<div class="studio-scenario" id="studio-scenario"><div class="studio-start"><b>Start with Q1 · Hainanese chicken rice</b><span>This is the offline ranking problem tested in Improve. Ask the SME to confirm the recipe task, then review D01 and D17 (direct answers) against D02 and D18 (search-tag pages). Inspect Q2–Q6 next for the full baseline; use Q1 alone to compare the recipe boost.</span></div><div class="ab-toolbar"><label>Scenario question<select id="studio-query">${data.queries.map(q=>`<option value="${q.id}" ${q.id===studioState.qid?'selected':''}>${q.id} · ${esc(q.text)}</option>`).join('')}</select></label></div><div class="ab-lanes"><section class="ab-lane"><div class="ab-lane-head"><span class="ab-arm">A</span><div class="improve-lane-title">Scenario · what the user needs</div></div><div id="studio-scenario-task"></div></section><section class="ab-lane"><div class="ab-lane-head"><span class="ab-arm">B</span><div class="improve-lane-title">Judgments · which documents help</div></div><div id="studio-scenario-grades"></div></section></div></div>`;
}
function renderStudioScenario(){
  const root=$('#studio-scenario');if(!root)return;
  const q=query(studioState.qid),terms=studioTerms[q.id]??[];
  root.querySelector('#studio-scenario-task').innerHTML=`<div class="studio-scenario-body"><p><b>Search text</b><br>${esc(q.text)}</p><p><b>User task</b><br>${esc(q.task)}</p><p><b>Search these document terms in Studio</b><br>${terms.map(term=>`<code>${esc(term)}</code>`).join(' · ')}</p></div>`;
  const judged=Object.entries(labels[q.id]??{}).map(([id,value])=>({id,rating:Number(value)})).sort((a,b)=>b.rating-a.rating||a.id.localeCompare(b.id));
  root.querySelector('#studio-scenario-grades').innerHTML=`<div class="studio-judgement-list">${judged.map(({id,rating})=>`<article class="studio-judgement"><span class="studio-grade grade-${rating}">Grade ${rating}</span><div><b>${esc(id)} · ${esc(doc(id)?.title??'Unknown document')}</b><p>${esc(doc(id)?.content??'')}</p></div></article>`).join('')}</div><p class="result-legend">0 wrong · 1 related · 2 useful · 3 direct answer.</p>`;
}
function wireStudioScenario(){const root=$('#studio-scenario');if(!root)return;root.querySelector('#studio-query').onchange=event=>{studioState.qid=event.target.value;renderStudioScenario()};renderStudioScenario()}
function viralBaseline(){
  const q=data.viralQuery;
  const hits=saved.viral.hybrid.hits;
  const rows=hits.map((hit,i)=>`<li><span>#${i+1} · ${esc(hit.id)}</span><b>${esc(doc(hit.id)?.title??'Unknown')}</b><small>grade ${grade('viral',hit.id)}/3</small></li>`).join('');
  return `<div class="online-baseline"><div class="online-query"><b>New search task · “${esc(q.text)}”</b><span>${esc(q.task)}</span></div><div class="online-rank-head"><b>What Hybrid · RRF returns</b><small>Captured Elasticsearch ranking + reviewed relevance grades</small></div><ol class="online-ranks">${rows}<li class="online-rank-target"><span>#${viralRank} · D08</span><b>Z&amp;V Cafe kaya toast recipe</b><small>grade 3/3 · below the top five</small></li></ol><p class="online-evidence"><b>The gap:</b> the six familiar offline queries scored well, but they did not include this newly popular search. The useful recipe is indexed yet buried at #${viralRank}; none of the visible top five answers the task.</p></div>`;
}
function onlineMetrics(){
  const original=data.queries.map(q=>observed(q.id,'hybrid')).filter(Boolean);
  const originalRR=original.map(item=>item.rr);
  const viral=observed('viral','hybrid');
  const originalMRR=original.length?originalRR.reduce((sum,value)=>sum+value,0)/original.length:null;
  const originalNDCG=original.length?original.reduce((sum,item)=>sum+item.ndcg,0)/original.length:null;
  const sample=data.onlineSimulation;
  const impressions=viralActive?sample.searchResultImpressions:0;
  const clicks=viralActive?sample.searchResultClicks:0;
  const usefulClicks=viralActive?sample.usefulResultClicks:0;
  const ctr=impressions?`${((clicks/impressions)*100).toFixed(1)}%`:'—';
  return `<section class="online-metric-story" aria-label="Offline versus online search quality"><div class="online-metric-group"><div class="online-metric-heading"><b>Offline · looks strong</b><small>${original.length} original judged queries</small></div><div class="online-metric-cards"><div><small>Hybrid mean NDCG@3</small><strong>${fmt(originalNDCG)}</strong><span>Average graded ranking quality</span></div><div><small>Hybrid MRR@3</small><strong>${fmt(originalMRR)}</strong><span>Average first useful rank</span></div></div><p>These scores describe the <b>original six-query test set</b>. The viral kaya-toast query was absent, so the strong averages did not test it.</p></div><div class="online-metric-group online-metric-group-sim"><div class="online-metric-heading"><b>Online · users still struggle</b><small>${viralActive?'Fictional event sample + captured ranking':'Trigger the post to reveal the event sample'}</small></div><div class="online-metric-cards"><div><small>Search CTR · simulated</small><strong>${ctr}</strong><span>${viralActive?`${clicks} clicks ÷ ${impressions} search impressions`:'Clicks ÷ search impressions'}</span></div><div><small>Useful-result clicks · simulated</small><strong>${viralActive?`${usefulClicks}/${clicks}`:'—'}</strong><span>Clicks on grade 2–3 results</span></div><div><small>New query NDCG@3 / RR@3</small><strong>${fmt(viral?.ndcg)} / ${fmt(viral?.rr)}</strong><span>Captured ranking + reviewed grades</span></div></div><p>${viralActive?`The ${sample.directReferrals} social referrals are excluded from CTR. Even ${ctr} search CTR can mean users click irrelevant results; none of the ${clicks} simulated search clicks reaches a useful result.`:'The offline metrics remain high even though the new query ranks its answer outside the visible top five.'}</p></div></section>`;
}
function renderViralStory(){
  const target=$('#viral-results'),button=$('#viral-trigger');if(!target||!button)return;
  button.textContent=viralActive?'↺ Reset the simulation':'Make the cafe post go viral →';
  target.innerHTML=`<p class="online-event-note">${viralActive?`<b>${data.onlineSimulation.directReferrals} direct social visits · simulated.</b> These visits show interest in D08 and are excluded from search CTR.`:'Trigger the post to simulate direct visits to D08.'}</p>${viralBaseline()}${onlineMetrics()}`;
}
function onlineContent(){
  const baseline=data.queries.map(q=>observed(q.id,'hybrid')).filter(Boolean),newCase=observed('viral','hybrid');
  const newMRR=(baseline.reduce((sum,item)=>sum+item.rr,0)+newCase.rr)/(baseline.length+1);
  const newNDCG=(baseline.reduce((sum,item)=>sum+item.ndcg,0)+newCase.ndcg)/(baseline.length+1);
  return panel('High offline scores, poor live experience',`<section class="online-phase"><h3><span class="stage-number">1</span> Trigger the event and inspect the same search</h3><div class="viral-simulation"><div class="viral-story"><div><strong>🍞 Z&amp;V Cafe’s kaya toast recipe goes viral</strong><p>D08 is already indexed. The post sends visitors directly to its recipe page.</p></div><button id="viral-trigger" type="button"></button></div><div class="viral-post"><small>Fictional social post · Z&amp;V Cafe</small><p>“Toast the bread, spread a thick layer of kaya, add cold butter, then cut. Serve with eggs and kopi.”</p></div><div id="viral-results" aria-live="polite"></div></div></section><section class="online-phase"><h3><span class="stage-number">2</span> Close the gap in the evaluation set</h3><div class="online-proof-next"><div><b>Why the scores missed it</b><p>NDCG@3 and MRR@3 were high on six judged queries. They cannot describe an unseen query. Review the new kaya-toast task and its relevance grades with an SME, then add it to the next offline test set.</p></div><div><b>Recalculate, then test a fix</b><p>With the new query included, Hybrid mean NDCG@3 is <b>${fmt(newNDCG)}</b> and MRR@3 is <b>${fmt(newMRR)}</b> across seven queries. The scores fall because the test set now covers the failure. Improve again tests a candidate offline; only a real online A/B test can establish user benefit.</p></div></div></section>`,'accent');
}
function onlineImprovedRankings(){
  const lane=(arm,mode,title)=>{
    const hits=saved.viral[mode].hits;
    const rows=hits.map((hit,i)=>`<li class="${hit.id==='D08'?'online-rank-target':''}"><span>#${i+1} · ${esc(hit.id)}</span><b>${esc(doc(hit.id)?.title??'Unknown')}</b><small>grade ${grade('viral',hit.id)}/3 · score ${fmt(hit.score)}</small></li>`).join('');
    const missing=mode==='hybrid'?`<li class="online-rank-target"><span>#${viralRank} · D08</span><b>Z&amp;V Cafe kaya toast recipe</b><small>grade 3/3 · below the top five</small></li>`:'';
    return `<section class="ab-lane online-compare-lane"><div class="ab-lane-head"><span class="ab-arm">${arm}</span><div class="improve-lane-title">${title}</div></div><ol class="online-ranks">${rows}${missing}</ol></section>`;
  };
  return `<div class="ab-lanes online-compare-lanes">${lane('A','hybrid','Hybrid RRF · current search')}${lane('B','hybridClick','Hybrid + guarded click rescore')}</div><p class="result-legend">Both lists are captured Elasticsearch runs on the same documents. Compare rank and relevance grade; the raw scores use different ranking calculations.</p>`;
}
function onlineAbExercise(){
  const {A,B}=data.abSimulation;
  const rate=(count,total)=>`${(100*count/total).toFixed(1)}%`;
  const completionLift=100*(B.recipeTaskCompletions/B.searchSessions-A.recipeTaskCompletions/A.searchSessions);
  const row=(arm,sample)=>`<tr><th scope="row">${arm}</th><td>${sample.searchSessions}</td><td>${sample.recipeTaskCompletions} / ${sample.searchSessions} = <b>${rate(sample.recipeTaskCompletions,sample.searchSessions)}</b></td><td>${sample.reformulations} / ${sample.searchSessions} = ${rate(sample.reformulations,sample.searchSessions)}</td><td>${sample.searchResultClicks} / ${sample.searchSessions} = ${rate(sample.searchResultClicks,sample.searchSessions)}</td></tr>`;
  return `<div class="ab-test-steps"><div><b>1 · Randomize</b><span>Assign search users 50/50 to A or B. Keep each user in the same arm; run both arms at the same time.</span></div><div><b>2 · Change one thing</b><span>A serves Hybrid RRF. B serves Hybrid plus the guarded click rescore. Use the same index, query and UI; freeze the click-count feature during the test.</span></div><div><b>3 · Log outcomes</b><span>For each search session, record its arm, query, result impression, clicked document, reformulation and whether the recipe task was completed. Exclude direct social visits and bots.</span></div><div><b>4 · Decide</b><span>Compare task completion first; use reformulation and CTR to explain behaviour. Check other queries, latency and safety, and estimate uncertainty before rollout.</span></div></div><div class="ab-example"><b>Worked A/B example · fictional search sessions</b><div class="table-wrap"><table><thead><tr><th>Arm</th><th>Sessions</th><th>Recipe task completed · primary</th><th>Reformulated · diagnostic</th><th>Search CTR · supporting</th></tr></thead><tbody>${row('A',A)}${row('B',B)}</tbody></table></div><p>B is <b>+${completionLift.toFixed(1)} percentage points</b> on task completion in this fictional example. It illustrates the calculation, not a measured win. A real decision needs enough randomized traffic, a confidence interval, and acceptable guardrails.</p></div>`;
}
function onlineImproveContent(){
  const q=data.viralQuery,before=observed('viral','hybrid'),after=observed('viral','hybridClick');
  const update=snippet('POST',`${indexName}/_update/D08?refresh=wait_for`,{doc:{click_count:500}});
  const rrf=searchBody('hybrid',q.text).retriever;
  const candidate=snippet('GET',`${indexName}/_search`,{size:5,_source:['title','content','category','status','click_count'],retriever:{rescorer:{retriever:rrf,rescore:{window_size:10,query:{rescore_query:{script_score:{query:{bool:{must:[{match:{title:{query:q.text,operator:'and'}}}],filter:[{term:{category:'recipe'}}]}},script:{source:"Math.sqrt(doc['click_count'].value * params.factor)",params:{factor:0.05}}}},query_weight:1,rescore_query_weight:1}}}}});
  const scores=[['NDCG@3',before.ndcg,after.ndcg],['RR@3',before.rr,after.rr],['Recall@3',before.recall,after.recall],['Precision@3',before.precision,after.precision]];
  const scoreCards=scores.map(([name,a,b])=>`<div><small>${name} · offline</small><strong>${fmt(a)} → ${fmt(b)}</strong></div>`).join('');
  return panel('Improve the ranking, then test it with users',`
    <section class="online-phase"><h3><span class="stage-number">1</span> Test one ranking change offline</h3><p>Keep <b>Hybrid · RRF</b> as A. B rescores the same top-10 hybrid candidates using the simulated click signal. D08 was #${viralRank} in that pool, so rescoring can move it; a document outside the pool could not be rescued.</p><div class="improve-check"><b>Guardrail</b><span>Only a <code>recipe</code> whose title matches all query terms receives a bonus. <code>sqrt(click_count × 0.05)</code> dampens large counts. These are workshop choices to validate, not production defaults.</span></div><details class="improve-rerun"><summary>Optional: inspect the Elasticsearch update and query</summary>${code('Record the fictional referral clicks',update)}${code('Hybrid RRF + guarded click rescore',candidate)}</details></section>
    <section class="online-phase"><h3><span class="stage-number">2</span> Compare the returned results, then the scores</h3><p>Same query: <b>${esc(q.text)}</b>. The judged recipe D08 should move from #${viralRank} to #1 without damaging other search tasks.</p>${onlineImprovedRankings()}<div class="improve-score-strip">${scoreCards}</div><p class="result-legend">These are <b>offline relevance scores</b> from captured Elasticsearch results and fixed judgments. They show a promising ranking change, not user benefit.</p><details class="calculation-disclosure"><summary>Check the original six questions for regressions</summary><p>The guarded candidate was also run against the six original questions. Compare all four metrics; this fixed set cannot rule out future-query regressions.</p>${crossQueryCheck()}</details></section>
    <section class="online-phase"><h3><span class="stage-number">3</span> Put the offline check in CI/CD</h3><p>Make the benchmark a release gate, not a one-off screenshot. Version the query set, relevance judgments, search strategy and index/data snapshot together. Run A and B on the <b>same</b> data and at the same K.</p><div class="ci-flow"><div><b>1 · Pull request</b><span>Propose the ranking change and record its baseline.</span></div><div><b>2 · CI benchmark</b><span>Run all judged queries in Relevance Studio or Elasticsearch <code>_rank_eval</code>.</span></div><div><b>3 · Gate</b><span>Require D08 to reach the top result; reject critical-query regressions and unacceptable latency.</span></div><div><b>4 · Staged release</b><span>Only a passing candidate moves to a canary or experiment.</span></div></div><p class="result-legend">Compare per-query NDCG, RR, recall and precision, not just the average. Use agreed tolerances for the other queries; there is no universal “good” score. A scheduled benchmark on refreshed data can catch drift between releases. Keep cluster credentials in the CI secret store, never on this public page.</p></section>
    <section class="online-phase"><h3><span class="stage-number">4</span> Run an online A/B test</h3><div class="improve-check"><b>How often?</b><span>There is no fixed schedule. Test a meaningful candidate when its effect on users is uncertain, not every query or every deployment. Plan the sample size and duration before launch, cover full weekly usage patterns where relevant, then ship, revise or stop. Monitor the live search continuously between tests.</span></div><p>After the CI gate passes, <b>randomize users</b> 50/50 and keep each user in one arm. Measure eligible search sessions; account for repeated sessions from the same user when estimating uncertainty.</p>${onlineAbExercise()}<p class="result-legend"><b>Close the loop:</b> have an SME confirm the new task and expert evaluators review its judgments. Add the case and later real user failures to the next offline benchmark. Do not treat this fictional A/B table as production evidence.</p></section>`,'accent');
}
function rawContent(){const q=step===0?query('Q1'):query();switch(step){
case 0:return panel('See what different searches return',`<p>Search the <b>same question</b> with two methods. Read the actual food documents in each result list before learning the metrics.</p>${abWorkbench('intro')}${callout('What you will be able to do','Run keyword, semantic and hybrid searches; judge results against a user task; explain a weak metric and fix its cause; then choose an offline candidate and check it with users. The page guides you through fixed Elasticsearch runs and their metric calculations. Dev Tools requests are available if you want to try them in your own project.')}`,'accent')+panel('What vector search adds',`<div class="three"><div><h3>Keyword</h3><p>BM25 matches analysed words. Strong for exact product IDs and explicit terms.</p></div><div><h3>Semantic</h3><p>Elastic Inference Service turns text into dense vectors. Similar meaning can match despite different wording.</p></div><div><h3>Hybrid</h3><p>RRF merges the two ranked lists without comparing their raw score scales.</p></div></div><p>Try <b>brinjal</b> against a document saying <b>eggplant sambal</b>. Then try <b>RC-123 rice cooker instructions</b>, where the exact model matters.</p>`);
case 1:return panel('Set up the project',`<ol class="checklist"><li>In Elastic Cloud, create a <b>Vector Database</b> Serverless project. An existing Elasticsearch Serverless project also supports these APIs, but this workshop targets the vector-oriented project type.</li><li>Open the project, then open <b>Dev Tools → Console</b>. Run the requests from this page there.</li><li>Use an index name unique to your project. The field above updates every request in this workshop.</li></ol><p><a href="https://www.elastic.co/docs/solutions/vector-database/get-started" target="_blank">Project setup documentation ↗</a> · <a href="https://www.elastic.co/guide/en/serverless/current/devtools-run-api-requests-in-the-console.html" target="_blank">Console documentation ↗</a></p>${code('Confirm this is Serverless',snippet('GET','/'))}${callout('Check the response','Look for <code>build_flavor: serverless</code>. Serverless is continuously updated; the reported version is for client compatibility and is not a reliable feature gate.')}<p class="muted">Creating a project and using inference can incur charges under your Elastic plan. This lab never asks for your API key.</p>`,'accent');
case 2:return panel('Create the index mapping',`<p><code>content</code> stays a searchable text field for BM25. <code>copy_to</code> sends the same text to <code>semantic_content</code>, where <code>semantic_text</code> uses the explicitly named Jina embedding endpoint. <code>category</code> and <code>status</code> are exact-match metadata fields; <code>click_count</code> stores a later aggregate engagement signal.</p>${code('Run once in Dev Tools',mapping())}${code('Inspect the mapping',snippet('GET',`${indexName}/_mapping`))}${callout('Inspect',`Verify <code>semantic_content.type</code> is <code>semantic_text</code> and <code>inference_id</code> is <code>${esc(data.model)}</code>. Pinning the endpoint keeps this workshop from silently switching embedding models when defaults change.`)}`,'accent');
case 3:return panel('Ingest the food documents',`<p>These ${data.documents.filter(d=>d.initial).length} Singapore food documents are fictional. The bulk request indexes them and triggers embedding generation through Elastic Inference Service. One cafe recipe will matter later, after the offline exercises.</p>${code(`Index ${data.documents.filter(d=>d.initial).length} documents`,bulk())}${code('Check count and one source document',`${snippet('GET',`${indexName}/_count`)}\n\n${snippet('GET',`${indexName}/_doc/D01`)}`)}${callout('Check the response',`The bulk response should have <code>errors: false</code>. The count should be ${data.documents.filter(d=>d.initial).length}. If either differs, inspect individual bulk item errors before continuing.`)}`,'accent');
case 4:return panel('Run the keyword baseline',`<p>BM25 searches the <code>content</code> text field. Use the selected query above. Its text and task stay fixed while you compare retrieval methods.</p>${methodPreview('keyword')}${code('Keyword search · top 3',search('keyword'))}${callout('Inspect','Read the returned IDs, titles and rank order. Does lexical matching favour a page that repeats the terms but does not answer the task? Check the captured result cards and grades.')}`,'accent');
case 5:return panel('Run semantic vector search',`<p>The <code>match</code> query on <code>semantic_content</code> performs vector search through the Jina dense embedding endpoint. Elasticsearch generated document vectors during ingest and generates the query vector at search time.</p>${methodPreview('vector')}${code('Semantic search · top 3',search('vector'))}${callout('Inspect','Try Q2, “brinjal.” D04 says “eggplant sambal.” Does the vector path find it? Also try Q4, an exact rice-cooker model; semantic similarity alone may not protect identifier precision.')}`,'accent')+panel('Optional: inspect explicit kNN mechanics',`<p>This separate toy index uses <code>dense_vector</code> directly. The three-number vectors are hand-written coordinates, <b>not real text embeddings</b>. It demonstrates <code>k</code>, <code>num_candidates</code> and nearest-neighbour retrieval. Real applications must embed documents and queries with the same model.</p><details><summary>Show optional BYOV commands</summary>${code('Create, index and query toy vectors',byov())}</details>`);
case 6:return panel('Run hybrid retrieval with RRF',`<p>One retriever searches <code>content</code>; the other searches <code>semantic_content</code>. Reciprocal rank fusion combines their <b>positions</b>. The request considers up to <b>10 candidates from each list</b> (<code>rank_window_size</code>) and displays the final <b>top 3</b> (<code>size</code>). The candidate pool is the shortlist eligible for fusion; it is not the number of results shown.</p>${methodPreview('hybrid')}${code('Hybrid search · top 3',search('hybrid'))}${callout('How fusion works','For each document, add <code>1 ÷ (60 + rank)</code> from every list where it appears. Rank 1 in one list earns <code>1/61</code>. A document ranked 2 in keyword and 1 in semantic earns <code>1/62 + 1/61</code>, so evidence from both lists can help it rise. The value 60 is the RRF rank constant, not a relevance grade.')}${callout('Inspect','Compare Semantic and Hybrid side by side here. The fusion query considered up to 10 candidates from each retriever. RRF scores use a different scale from vector scores; compare rank positions and relevance metrics, not raw scores.')}`,'accent');
default:return ''}}

function compactPanels(html,groups){
  const template=document.createElement('template');template.innerHTML=html;
  const panels=Array.from(template.content.children).filter(element=>element.classList.contains('panel'));
  if(groups.some(group=>group.parts.some(index=>!panels[index])))return html;
  return groups.map(group=>panel(esc(group.title),group.parts.map(index=>{
    const original=panels[index].cloneNode(true);
    const heading=original.querySelector(':scope > h2, :scope > .panel-title-row > h2');
    const title=heading?.textContent??`Part ${index+1}`;
    const titleRow=original.querySelector(':scope > .panel-title-row');
    const actions=titleRow?Array.from(titleRow.children).filter(child=>child!==heading).map(child=>child.outerHTML).join(''):'';
    titleRow?.remove();
    heading?.remove();
    if((step===5&&index===2)||(step===9&&[4,11].includes(index)))return `<details class="lesson-optional"><summary>${esc(title)}</summary>${original.innerHTML}</details>`;
    return `<div class="lesson-part"><div class="lesson-heading"><h3>${esc(title)}</h3>${actions}</div>${original.innerHTML}</div>`
  }).join(''),group.parts.includes(0)?'accent':'')).join('')
}
function compactSearchPanels(html){
  const template=document.createElement('template');template.innerHTML=html;
  const panels=Array.from(template.content.children).filter(element=>element.classList.contains('panel'));
  if(!panels.length)return html;
  const request=panels[0].cloneNode(true);
  const preview=request.querySelector('.method-preview');
  if(!preview)return html;
  preview.remove();
  request.querySelector('.callout')?.remove();
  request.querySelector(':scope > h2')?.remove();
  const optional=step===5&&panels[1]?`<details class="lesson-optional"><summary>Optional: inspect explicit kNN mechanics</summary>${panels[1].innerHTML.replace(/^\s*<h2>[^<]*<\/h2>/,'')}</details>`:'';
  const label=step===4?'Keyword · BM25':step===5?'Vector · semantic':'Hybrid · RRF';
  const beforeMode=step===5?'keyword':step===6?'vector':null,afterMode=step===5?'vector':step===6?'hybrid':null;
  const takeaway=beforeMode?`${comparisonTakeaway(queryId,beforeMode,afterMode)}<br>${abLesson(queryId)}`:abLesson(queryId);
  return panel(label,`<div class="search-workflow"><section class="search-stage search-run"><h3><span class="stage-number">1</span> See the search request</h3>${request.innerHTML}${optional}</section><section class="search-stage search-inspect"><h3><span class="stage-number">2</span> Inspect the captured results and scores</h3>${preview.outerHTML}${callout('Look for',takeaway)}</section></div>`,'accent')
}
function content(){
  if(step===7)return evaluateContent();
  if(step===8)return improveContent();
  if(step===9)return studioVisualContent();
  if(step===10)return onlineContent();
  if(step===11)return onlineImproveContent();
  const html=rawContent();
  if(step>=4&&step<=6)return compactSearchPanels(html);
  const groups={
    0:[{title:'Explore the three search methods',parts:[0,1]}],
    4:[{title:'Keyword: search and inspect',parts:[0,1]}],
    5:[{title:'Vector: compare and inspect',parts:[0,1,2]}],
    6:[{title:'Hybrid: combine and inspect',parts:[0,1]}],
    7:[{title:'Evaluate and diagnose',parts:[0,1]}],
    8:[{title:'Repair missing content',parts:[0,1]},{title:'Filter stale content',parts:[2,3]},{title:'Test title weighting',parts:[4,5,6]},{title:'Scale the comparison',parts:[7]}],
    9:[{title:'Set up Studio',parts:[0,1,2]},{title:'Create judgments',parts:[3,4]},{title:'Create search strategies',parts:[5,6,7,8]},{title:'Benchmark and choose',parts:[9,10,11,12]}],
    10:[{title:'Compare and test with users',parts:[0,1]},{title:'Bring failures back offline',parts:[2]}]
  };
  return groups[step]?compactPanels(html,groups[step]):html
}

function wire(){
  wireAbWorkbench();
  wireStudioScenario();
  renderMethodPreview();
  const viralButton=$('#viral-trigger');if(viralButton){viralButton.onclick=()=>{viralActive=!viralActive;renderViralStory()};renderViralStory()}
  document.querySelectorAll('[data-copy]').forEach(button=>button.onclick=async()=>{try{await navigator.clipboard.writeText(snippets[button.dataset.copy]);status(button.dataset.copyTarget==='studio'?'Strategy body copied. Paste it into a Relevance Studio strategy.':'Console request copied. Paste it into your project’s Dev Tools.')}catch{status('Clipboard access failed. Select and copy the code block manually.')}});
}
function stagePanels(){return Array.from($('#stage').children).filter(element=>element.classList.contains('panel'))}
function updateSectionView(){
  const panels=stagePanels(),nav=$('#section-nav');
  nav.hidden=panels.length<=1;
  if(panels.length<=1)return;
  const active=Math.max(0,Math.min(panels.length-1,Number(sectionByStep[step])||0));
  sectionByStep[step]=active;
  panels.forEach((panel,i)=>{panel.hidden=!showAllSections&&i!==active});
  $('#section-count').textContent=showAllSections?`All ${panels.length} sections`:`Section ${active+1} of ${panels.length}`;
  $('#section-tabs').innerHTML=panels.map((panel,i)=>{const title=(panel.querySelector('h2')?.textContent??`Section ${i+1}`).replace(/^\d+[a-z]?\.\s*/i,'');return `<button type="button" class="section-tab ${!showAllSections&&i===active?'active':''}" data-section="${i}" ${!showAllSections&&i===active?'aria-current="true"':''}>${i+1}. ${esc(title)}</button>`}).join('');
  $('#toggle-sections').textContent=showAllSections?'Focus on one section':'Show all sections';
  $('#section-previous').disabled=showAllSections||active===0;
  $('#section-next').disabled=showAllSections||active===panels.length-1;
  document.querySelectorAll('[data-section]').forEach(button=>button.onclick=()=>setSection(Number(button.dataset.section)));
  saveState()
}
function setSection(i){sectionByStep[step]=i;showAllSections=false;updateSectionView();window.scrollTo(0,0)}
function navigateStepByKeyboard(event){
  if(!['ArrowLeft','ArrowRight'].includes(event.key)||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||event.isComposing||event.repeat)return;
  const target=event.target;
  if(target instanceof Element&&target.closest('input, textarea, select, [contenteditable], [role="textbox"], [role="slider"]'))return;
  const next=step+(event.key==='ArrowRight'?1:-1);
  if(next<0||next>=steps.length)return;
  event.preventDefault();
  setStep(next);
}
function render(){snippets={};$('#eyebrow').textContent=`STEP ${step+1} OF ${steps.length} · SERVERLESS VECTOR DATABASE`;$('#title').textContent=steps[step][1];$('#why').textContent=steps[step][2];$('#nav').innerHTML=steps.map((s,i)=>`<button class="${i===step?'active':''}" data-step="${i}" ${i===step?'aria-current="step"':''}><span>${String(i+1).padStart(2,'0')}</span>${esc(s[0])}</button>`).join('');const chooseQuery=step>=4&&step<=6;$('#workshop-context').hidden=step!==1&&!chooseQuery;$('#workshop-context').classList.toggle('index-only',step===1);$('#workshop-context').classList.toggle('search-only',chooseQuery);$('#index-control').hidden=step!==1;$('#query-control').hidden=!chooseQuery;$('#context-task').hidden=!chooseQuery;$('#context-task').innerHTML=chooseQuery?`<b>${query().id} task:</b> ${esc(query().task)}`:'';$('#stage').innerHTML=content();$('#previous').disabled=step===0;$('#next').disabled=step===steps.length-1;$('#next').textContent=step===7?'Improve offline →':step===8?'Relevance Studio →':step===9?'Online event →':step===10?'Improve again →':'Next step →';document.querySelectorAll('[data-step]').forEach(button=>button.onclick=()=>setStep(Number(button.dataset.step)));document.querySelectorAll('[role="button"][data-step]').forEach(button=>button.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setStep(Number(button.dataset.step))}});wire();updateSectionView();saveState()}
function setStep(i){step=Math.max(0,Math.min(steps.length-1,i));sectionByStep[step]=0;showAllSections=false;status('');render();window.scrollTo(0,0)}
async function init(){
  const response=await fetch('./workshop-data.json');
  if(!response.ok)throw Error(`Could not load workshop data (HTTP ${response.status}).`);
  data=await response.json();
  let restored={};
  try{restored=JSON.parse(localStorage.getItem(STORE)||'{}')}catch{}
  step=Number.isInteger(restored.step)?Math.max(0,Math.min(steps.length-1,restored.step)):0;
  queryId=data.queries.some(q=>q.id===restored.queryId)?restored.queryId:'Q1';
  indexName=INDEX_PATTERN.test(restored.indexName??'')?restored.indexName:data.index;
  labels=Object.fromEntries([...data.queries,data.viralQuery].map(q=>[q.id,{...q.labels}]));
  sectionByStep=restored.sectionByStep??{};
  sectionByStep[step]=0;
  await loadFixedResults();
  $('#index-name').value=indexName;
  $('#query-select').innerHTML=data.queries.map(q=>`<option value="${q.id}">${q.id} · ${esc(q.text)}</option>`).join('');
  $('#query-select').value=queryId;
  $('#index-name').onchange=event=>{const value=event.target.value.trim();if(!INDEX_PATTERN.test(value)){event.target.value=indexName;status('Use an index name beginning with a lowercase letter, then lowercase letters, digits, hyphens or underscores.');return}indexName=value;render();status('Index name updated in every Console request.')};
  $('#query-select').onchange=event=>{queryId=event.target.value;render();status(`Workshop query changed to ${queryId}.`)};
  $('#stage').onclick=event=>{const button=event.target.closest('[data-try-query]');if(!button)return;queryId=button.dataset.tryQuery;$('#query-select').value=queryId;render();status(`Workshop query changed to ${queryId}.`)};
  $('#previous').onclick=()=>setStep(step-1);
  $('#next').onclick=()=>setStep(step+1);
  $('#section-previous').onclick=()=>setSection((sectionByStep[step]||0)-1);
  $('#section-next').onclick=()=>setSection((sectionByStep[step]||0)+1);
  $('#toggle-sections').onclick=()=>{showAllSections=!showAllSections;updateSectionView()};
  document.addEventListener('keydown',navigateStepByKeyboard);
  render();status('');
}
init().catch(error=>status(`Workshop could not load: ${error.message}`));
