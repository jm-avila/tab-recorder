const status = document.getElementById('status');
const tabId = Number(new URLSearchParams(location.search).get('tabId'));

try {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
  status.textContent = 'Microphone allowed.';
} catch {
  status.textContent = 'Microphone blocked: recording tab audio only. Change it in the site settings for this extension.';
}

// Start on the tab the icon was clicked on, go back to it and close this page.
if (tabId) {
  await chrome.runtime.sendMessage({ target: 'background', type: 'start', tabId });
  await chrome.tabs.update(tabId, { active: true });
  const self = await chrome.tabs.getCurrent();
  await chrome.tabs.remove(self.id);
}
