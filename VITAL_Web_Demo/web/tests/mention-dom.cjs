const {JSDOM}=require("jsdom");
const fs=require("node:fs");const assert=require("node:assert/strict");
const dom=new JSDOM('<article id="article"><p>Anna met <strong>Anna</strong> in Bergen.</p><p>Anna discussed measles.</p></article>',{runScripts:"outside-only",url:"https://example.com/story"});
const w=dom.window;w.HTMLElement.prototype.scrollIntoView=()=>{};
w.eval(fs.readFileSync("web/assets/mention-navigation.js","utf8"));
const root=w.document.querySelector("article");
for(const index of [1,2,3,1]) {const r=w.vitalFindMention(root,"Anna");assert.equal(r.index,index);assert.equal(r.count,3);}
assert.equal(w.vitalFindMention(root,"ann").found,false);
assert.equal(w.vitalFindMention(root,"Measles").count,1);
assert.equal(w.vitalFindMention(root,"unknown").found,false);
assert.ok(root.querySelector("strong"));
assert.equal(root.querySelectorAll("mark").length,0);
dom.window.close();console.log("Mention navigation passed: first/next/wrap, word boundaries, case and original markup.");
