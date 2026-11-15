// the side panel can't ask for the mic, so we ask here and release it right away
const status = document.querySelector<HTMLElement>('#status')!;
const BLOCKED = 'The microphone is blocked for Access OS. Click the icon left of the address bar, set Microphone to Allow, then reload this page.';
const READY = 'Microphone enabled! You can close this tab and return to Access OS.';

void navigator.permissions.query({ name: 'microphone' as PermissionName }).then((permission) => {
  if (permission.state === 'granted') status.textContent = READY;
  if (permission.state === 'denied') status.textContent = BLOCKED;
});

document.querySelector('#allow-mic')?.addEventListener('click', async () => {
  status.textContent = 'Requesting microphone access...';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    status.textContent = READY;
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    status.textContent = name === 'NotAllowedError' ? BLOCKED
      : name === 'NotFoundError' ? 'No microphone was found. Connect one and try again.'
      : 'Microphone access failed. Please try again.';
  }
});
