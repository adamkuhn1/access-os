export default defineBackground(() => {
  // clicking the toolbar icon opens the Access OS side panel
  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
