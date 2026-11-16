async page => {
  let accounts=__DALEI_PRIVATE_ACCOUNTS__;
  const results=[];
  try {
    for(const account of accounts) {
      const p=page.context().pages().find(p=>p.url().startsWith(account.origin+'/'));
      if(!p){results.push({system:account.system,status:'page_unavailable'});continue;}
      if(!p.url().startsWith(account.origin+'/auth/login')) {
        results.push({system:account.system,status:'already_authenticated'});continue;
      }
      // These selectors were read from the three actual TOPWMS login pages.
      if(account.system==='haohuolai') {results.push({system:account.system,status:'layout_not_confirmed'});continue;}
      const username=p.locator('input[placeholder="请输入手机号"]');
      const password=p.locator('input[placeholder="请输入密码"][type="password"]');
      if(await username.count()!==1||await password.count()!==1) {
        results.push({system:account.system,status:'layout_not_confirmed'});continue;
      }
      try {
        if(!p.url().startsWith(account.origin+'/')){results.push({system:account.system,status:'origin_changed'});continue;}
        await username.fill(account.username);
        if(!p.url().startsWith(account.origin+'/')){results.push({system:account.system,status:'origin_changed'});continue;}
        await password.fill(account.password);
        const agreement=p.locator('input[type="checkbox"]');
        const needsAgreement=await agreement.count()===1 && !(await agreement.isChecked());
        // User handles the first agreement acceptance and any verification.
        if(needsAgreement){results.push({system:account.system,status:'filled_waiting_user_login',requiresAgreementOrCaptcha:true});continue;}
        await p.getByRole('button',{name:'登录',exact:true}).click();
        await p.waitForURL(url=>url.origin===account.origin&&!url.pathname.startsWith('/auth/login'),{timeout:10000}).catch(()=>{});
        results.push({system:account.system,status:p.url().startsWith(account.origin+'/auth/login')?'login_not_confirmed':'login_success',requiresAgreementOrCaptcha:p.url().startsWith(account.origin+'/auth/login')});
      } catch {results.push({system:account.system,status:'credentials_fill_failed'});}
      finally {account.username=null;account.password=null;}
    }
    return results;
  } finally {for(const account of accounts){account.username=null;account.password=null;}accounts=null;}
}
