// SPDX-License-Identifier: MPL-2.0
// Uses the standalone SearchPanel IIFE served at :18765 (see layout test setup).
// One owned Wiki tab; callbacks record actions, never submit edits or mutate real data.
async page => {
  const context = page.context();
  let fixture;
  try {
    const bundle = await (await page.request.get('http://127.0.0.1:18765/search-panel.js')).text();
    fixture = await context.newPage();
    await fixture.setViewportSize({ width: 1280, height: 900 });
    await fixture.goto('https://casualtiesunknown.huijiwiki.com/index.php?title=%E6%8A%97%E6%8A%91%E9%83%81%E8%8D%AF&action=edit', {waitUntil:'domcontentloaded',timeout:30000});
    await fixture.waitForFunction(() => window.__CU_WIKI_SEARCH__?.ready === true, undefined, {timeout:60000});
    await fixture.addScriptTag({content:bundle});
    await fixture.evaluate(() => {
      const legacy = document.querySelector('#cu-wiki-search-host');
      // Remove the old controller in this owned tab so two bundles cannot claim Alt+K.
      if (legacy) legacy.remove();
      const calls = [];
      const result = {id:1,title:'抗抑郁药',namespace:0,namespaceName:'（主）',score:1};
      const record = kind => () => calls.push(kind);
      const panel = new window.CuSearchPanel.SearchPanel({
        prepareSearch(){},prepareFiles(){},search:()=>[result],searchFiles:()=>[{...result,title:'文件:示例.png',namespace:6}],
        searchContent:()=>[{...result,kind:'content',snippet:'抗抑郁药示例正文',highlights:[{start:0,end:4}]}],
        searchLua:()=>[{...result,kind:'lua',title:'模块:示例',matches:[{kind:'function',value:'render'}]}],
        searchCss:()=>[{...result,kind:'css',title:'MediaWiki:Common.css',matches:[{line:1,text:'.sample { color: red; }',highlights:[]}]}],
        searchCodes:()=>[{kind:'data-code',source:'Data:示例.json',code:'example',chineseName:'示例',dataType:'item',score:1}],
        insert:record('insert'),copyTitle:record('copyTitle'),copy:record('copy'),copyCode:record('copyCode'),open:record('open'),openCode:record('openCode'),
        refresh(){},refreshFiles(){},saveDataCodeRules:async()=>{},saveHighlightPreferences(){},
      });
      const host=[...document.querySelectorAll('#cu-wiki-search-host')].at(-1);
      host.id='cu-a4-test';
      panel.setNamespaces([{id:0,name:'（主）'}]);
      panel.setStatus('本地 UI 验证 · 示例数据');
      panel.state.query='抗抑郁药';
      window.__A4_TEST__={panel,calls};
    });
    const host=fixture.locator('#cu-a4-test');
    const launcher=host.locator('.toggle');
    const panel=host.locator('.panel');
    const query=host.locator('.query');
    await launcher.click();
    await query.waitFor();
    if(await launcher.isVisible())throw Error('Expanded launcher remains visible');
    await fixture.keyboard.press('Escape');
    if(!await fixture.evaluate(()=>document.querySelector('#cu-a4-test').shadowRoot.activeElement?.classList.contains('toggle')))throw Error('Launcher focus did not return');
    // Exercise the shortcut from an independent editor-like input without changing Wiki content.
    await fixture.evaluate(()=>{const input=document.createElement('input');input.id='cu-a4-origin';input.style.cssText='position:fixed;left:0;top:0;z-index:2147483647';document.body.append(input);input.focus();});
    for(let i=0;i<3;i++){
      await fixture.keyboard.press('Alt+k');
      await fixture.waitForTimeout(50);
      if(!await fixture.evaluate(()=>document.querySelector('#cu-a4-test').shadowRoot.activeElement?.classList.contains('query')))throw Error('Shortcut query focus missing: '+JSON.stringify(await fixture.evaluate(()=>({visible:window.__A4_TEST__.panel.state.visible,connected:!!document.querySelector('#cu-a4-test'),active:document.activeElement?.outerHTML,shadow:document.querySelector('#cu-a4-test').shadowRoot.activeElement?.outerHTML}))));
      await fixture.keyboard.press('Escape');
      if(!await fixture.evaluate(()=>document.activeElement?.id==='cu-a4-origin'))throw Error('Shortcut origin focus missing');
    }
    const editorFocus=[];
    await fixture.waitForFunction(()=>!!document.querySelector('.CodeMirror')?.CodeMirror,undefined,{timeout:10000});
    for(const closeKey of ['Escape','Alt+k']) {
      const selection=await fixture.evaluate(()=>{
        const cm=document.querySelector('.CodeMirror').CodeMirror;
        cm.setSelection({line:1,ch:0},{line:1,ch:3});cm.focus();
        window.__A4_TEST__.editorText=cm.getValue();
        return JSON.stringify(cm.listSelections());
      });
      await fixture.keyboard.press('Alt+k');
      await panel.waitFor({state:'visible',timeout:5000});
      await query.waitFor();
      await fixture.keyboard.press(closeKey);
      await panel.waitFor({state:'hidden',timeout:5000});
      const result=await fixture.evaluate(expected=>{
        const cm=document.querySelector('.CodeMirror').CodeMirror;
        return {focused:cm.hasFocus(),selectionPreserved:JSON.stringify(cm.listSelections())===expected,textUnchanged:cm.getValue()===window.__A4_TEST__.editorText};
      },selection);
      if(!result.focused||!result.selectionPreserved||!result.textUnchanged)throw Error('Actual CodeMirror focus return failed: '+closeKey+JSON.stringify(result));
      editorFocus.push({closeKey,...result});
    }
    await launcher.click();
    const modes=[];
    for(const mode of ['title','content','data-code','lua','css','files']){
      await host.locator('.mode').selectOption(mode);
      await host.locator('.result').first().waitFor();
      await fixture.evaluate(()=>window.__A4_TEST__.calls.length=0);
      await host.locator('.result-primary').first().click();
      await query.focus();await fixture.keyboard.press('Enter');
      await host.locator('.open-result').first().click();
      const inserts=await host.locator('.insert-result:visible').count();
      if(inserts) {await host.locator('.insert-result').first().click();await launcher.click();}
      const calls=await fixture.evaluate(()=>window.__A4_TEST__.calls.slice());
      const expectedCopy=mode==='data-code'?'copyCode':'copyTitle';
      if(calls[0]!==expectedCopy||calls[1]!==expectedCopy||calls[2]!== (mode==='data-code'?'openCode':'open'))throw Error('Action semantics changed: '+mode+JSON.stringify(calls));
      if((inserts>0)!==['title','content','files'].includes(mode))throw Error('Insertion eligibility changed: '+mode);
      if(inserts ? calls.length!==4||calls[3]!=='insert' : calls.length!==3)throw Error('Unexpected action callbacks: '+mode+JSON.stringify(calls));
      modes.push({mode,calls,inserts});
    }
    await host.locator('.mode').selectOption('title');
    // Dock changes may move the launcher, never the open or user-positioned panel.
    await host.locator('.drag-handle').focus();await fixture.keyboard.press('ArrowLeft');await fixture.keyboard.press('ArrowUp');
    if(await panel.getAttribute('data-positioned')!=='true')throw Error('Panel never entered user-positioned state');
    const positioned=await panel.boundingBox();
    const dockState=await fixture.evaluate(()=>{
      const dock=document.querySelector('.skin-dock');
      if(!dock)throw Error('Site dock absent');
      const original=dock.getAttribute('style');
      dock.style.width='160px';
      return original;
    });
    await fixture.waitForTimeout(100);
    const afterDock=await panel.boundingBox();
    if(Math.abs(positioned.x-afterDock.x)>1||Math.abs(positioned.y-afterDock.y)>1||Math.abs(positioned.height-afterDock.height)>1)throw Error('Dock change moved/resized panel');
    await host.locator('.close').click();
    await fixture.waitForTimeout(80);
    const clearance=await fixture.evaluate(()=>{
      const a=document.querySelector('#cu-a4-test').shadowRoot.querySelector('.toggle').getBoundingClientRect(),b=document.querySelector('.skin-dock').getBoundingClientRect();return b.left-a.right;
    });
    if(clearance<11)throw Error('Launcher overlaps changed dock');
    await launcher.click();
    const reopened=await panel.boundingBox();
    if(Math.abs(positioned.x-reopened.x)>1||Math.abs(positioned.y-reopened.y)>1)throw Error('Reopen lost drag coordinates');
    await fixture.setViewportSize({width:375,height:780});
    await fixture.waitForTimeout(100);
    const narrow=await fixture.evaluate(()=>{const b=document.querySelector('#cu-a4-test').shadowRoot.querySelector('.panel').getBoundingClientRect();return {bottom:innerHeight-b.bottom,left:b.left,right:b.right,width:document.documentElement.clientWidth};});
    if(Math.abs(narrow.bottom-12)>1||narrow.left<11||narrow.right>narrow.width-11)throw Error('Narrow bounds mismatch');
    await fixture.setViewportSize({width:1280,height:900});await fixture.waitForTimeout(100);
    const restored=await panel.boundingBox();
    if(Math.abs(restored.x-positioned.x)>1||Math.abs(restored.y-positioned.y)>1)throw Error('Desktop position lost across breakpoint');
    await fixture.evaluate(original=>{const dock=document.querySelector('.skin-dock');if(original===null)dock.removeAttribute('style');else dock.setAttribute('style',original);},dockState);
    return {modes,editorFocus,launcherFocus:true,shortcutCycles:3,dockDoesNotMovePanel:true,clearance,narrow,desktopPositionRestored:true};
  } finally {
    if(fixture&&!fixture.isClosed())await fixture.close();
    await page.bringToFront();
  }
}
