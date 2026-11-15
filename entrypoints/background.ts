export default defineBackground(() => {
  // toolbar icon opens the side panel
  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
