async page => {
 let accounts=__DALEI_PRIVATE_ACCOUNTS__;
 try {
  const a=accounts.find(a=>a.system==='haohuolai');
  const p=page.context().pages().find(p=>p.url().startsWith(a.origin+'/account/login'));
  if(!p)return [{system:'haohuolai',status:'page_unavailable'}];
  const input=p.locator('input[placeholder="请输入"]');
  if(await input.count()!==1)return [{system:'haohuolai',status:'layout_not_confirmed'}];
  await input.fill(a.username);await input.blur();
  const password=p.locator('input[placeholder="请输入密码"][type="password"]');
  await password.waitFor({state:'visible',timeout:10000});
  await password.fill(a.password);
  await p.bringToFront();
  return [{system:'haohuolai',status:'filled_waiting_user_login'}];
 }finally{for(const a of accounts){a.username=null;a.password=null;}accounts=null;}
}
