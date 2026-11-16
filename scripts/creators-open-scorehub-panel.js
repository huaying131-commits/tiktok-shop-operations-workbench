(() => {
  const root = document.querySelector('example-ui')?.shadowRoot;
  if (!root) throw Error('ObservedScoreHubHostMissing');
  const controls = [...root.querySelectorAll('div,span,button')].filter(el => !el.children.length && el.textContent.trim() === 'ScoreHub' && el.getClientRects().length);
  if (controls.length !== 1) throw Error('ScoreHubEntryMissingOrAmbiguous');
  controls[0].click();
  return {panelEntryClicked: true, loginSubmitted: false};
})()
