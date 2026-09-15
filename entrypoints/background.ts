export default defineBackground(() => {
  console.log('Hello background!', { id: browser.runtime.id });

  // Abrir o Side Panel ao clicar no ícone da extensão (Chrome)
  browser.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true });
});
