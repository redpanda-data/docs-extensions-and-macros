const groups = { count:1, next:null, results:[
  { id:'parent-1', name:'Streaming', type:'product', sub_groups:[ {id:'g-current', name:'current', type:'version'} ] }
]}
const sources = { count:2, next:null, results:[
  { id:'s1', name:'Documentation (current)', type:'scrape', source_groups:[{id:'g-current'}] },
  { id:'s2', name:'Cloud', type:'scrape', source_groups:[] }
]}
globalThis.fetch = async (url) => {
  const body = String(url).includes('/source-groups/') ? groups : sources
  return { ok:true, status:200, statusText:'OK', json: async () => body }
}
