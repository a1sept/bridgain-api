// Self-contained OAuth callback view; provider tokens and desktop claim secrets
// never enter this document. The capability below can only record one choice.
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function githubAccountPage(p: {nonce:string;state:string;secret:string;login:string;accountId?:number}) {
  const data = JSON.stringify({state:p.state,secret:p.secret}).replace(/</g,'\\u003c');
  const avatar = Number.isSafeInteger(p.accountId) && p.accountId! > 0
    ? `<img src="https://avatars.githubusercontent.com/u/${p.accountId}?s=96" alt="" width="40" height="40" referrerpolicy="no-referrer">`
    : `<span aria-hidden="true">${escapeHtml(p.login.slice(0,1).toUpperCase())}</span>`;
  return githubPage(p.nonce, `<div class="brand"><span class="logo" aria-hidden="true">b</span><span>Bridgain</span></div><h1>GitHub 연결</h1><p>이 계정으로 저장소를 연결합니다.</p><form method="post" action="/api/workspace/github/callback/choice"><input type="hidden" name="state" value="${escapeHtml(p.state)}"><input type="hidden" name="secret" value="${escapeHtml(p.secret)}"><div class="account"><div class="avatar">${avatar}</div><div class="identity"><strong>@${escapeHtml(p.login)}</strong><small>GitHub 계정</small></div><button class="change" type="submit" name="decision" value="switch" data-choice="switch" aria-label="GitHub 계정 변경">변경</button></div><div class="actions"><button type="submit" name="decision" value="cancel" data-choice="cancel">취소</button><button class="primary" type="submit" name="decision" value="connect" data-choice="connect">연결하기</button></div></form><p class="hint">연결하기 전까지 기존 계정은 유지됩니다.</p><p id="status" role="status" aria-live="polite"></p>`, `
<script nonce="${escapeHtml(p.nonce)}">
(() => {
const credentials=${data};
// Remove the spent OAuth code from the visible address and browser history.
try { history.replaceState(null,'',location.pathname); } catch {}
const statusElement=document.getElementById('status');const buttons=[...document.querySelectorAll('[data-choice]')];let busy=false;
for(const button of buttons)button.addEventListener('click',async(event)=>{
 event.preventDefault();
 if(busy)return;busy=true;buttons.forEach(b=>b.disabled=true);statusElement.className='';statusElement.textContent='선택을 전달하고 있습니다…';
 try{const response=await fetch('/api/workspace/github/callback/decision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...credentials,decision:button.dataset.choice}),cache:'no-store',signal:AbortSignal.timeout(20000)});const result=await response.json();if(!response.ok)throw Error(result.message||'연결 요청을 확인하지 못했습니다.');
 statusElement.textContent=button.dataset.choice==='connect'?'계정을 확인했습니다. 데스크톱 앱에서 연결을 마무리합니다. 앱으로 돌아가주세요.':button.dataset.choice==='switch'?'데스크톱 앱이 새 GitHub 계정 선택 창을 엽니다. 새 창에서 다른 계정을 선택해주세요.':'연결을 취소했습니다. 기존 연결은 유지됩니다. 앱으로 돌아가주세요.';
 }catch(error){statusElement.className='error';statusElement.textContent=error.message+' 앱에서 취소 후 다시 시작할 수 있습니다.';busy=false;buttons.forEach(b=>b.disabled=false);}
});
})();
</script>`);
}

export function githubAccountResultPage(nonce: string, decision?: unknown) {
  const message = decision === 'connect'
    ? '계정을 확인했습니다. 데스크톱 앱으로 돌아가 연결 상태를 확인해주세요.'
    : decision === 'switch'
      ? '데스크톱 앱이 새 GitHub 계정 선택 창을 엽니다. 새 창에서 다른 계정을 선택해주세요.'
      : decision === 'cancel'
        ? '연결을 취소했습니다. 기존 연결은 유지됩니다. 앱으로 돌아가주세요.'
        : '연결 요청이 만료되었거나 처리되지 않았습니다. 데스크톱 앱에서 취소 후 다시 인증해주세요.';
  return githubPage(nonce, `<div class="brand"><span class="logo" aria-hidden="true">b</span><span>Bridgain</span></div><h1>GitHub 연결</h1><p role="status">${message}</p>`);
}

function githubPage(nonce: string, content: string, script = '') {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub 계정 확인 · Bridgain</title>
<style nonce="${escapeHtml(nonce)}">
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:32px 24px;background:#f6f8fc;color:#25344b;font:14px/1.6 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:100%;max-width:400px}
.brand{display:flex;align-items:center;gap:9px;margin-bottom:36px;font-size:15px;font-weight:650}
.logo{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:#426fe9;color:#fff;font-size:21px;font-weight:750;line-height:1}
h1{font-size:24px;font-weight:650;line-height:1.35;letter-spacing:-.025em;margin:0 0 8px}
p{margin:0;color:#5f6d83}
.account{display:flex;align-items:center;gap:12px;margin:28px 0 32px}
.avatar{display:grid;place-items:center;width:40px;height:40px;flex-shrink:0;border-radius:50%;overflow:hidden;background:#e8edf6;color:#4c6080;font-size:16px;font-weight:600}
.avatar img{display:block;width:100%;height:100%;object-fit:cover}
.identity{flex:1;min-width:0}.identity strong{display:block;font-size:15px;font-weight:600;overflow-wrap:anywhere}.identity small{display:block;color:#65738a;font-size:12px}
button{min-height:34px;padding:7px 12px;border:0;border-radius:7px;background:transparent;color:#526178;font-family:inherit;font-weight:500;font-size:12px;line-height:18px;cursor:pointer}
button:hover{background:#e9eef7}button:focus-visible{outline:2px solid #426fe9;outline-offset:3px}button:disabled{opacity:.55;cursor:default}
.change{color:#315ccc;flex-shrink:0}.actions{display:flex;justify-content:flex-end;gap:8px}.primary{background:#426fe9;color:#fff;font-weight:600;min-width:92px}.primary:hover{background:#345ed3}
.hint{font-size:12px;margin-top:16px;color:#65738a}
#status{font-size:13px;margin-top:16px}#status:empty{display:none}#status.error{color:#b42336}
@media(max-width:420px){body{padding:28px 24px}.brand{margin-bottom:28px}}
</style></head><body><main>${content}</main>${script}</body></html>`;
}
