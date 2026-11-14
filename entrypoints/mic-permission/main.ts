const button = document.querySelector<HTMLButtonElement>(
  '#allow-mic'
);

const status = document.querySelector<HTMLElement>('#status');

const BLOCKED_MESSAGE =
  'Microphone is blocked for Access OS. Click the icon to the left of the address bar, set Microphone to Allow, then reload this page.';

navigator.permissions
  .query({ name: 'microphone' as PermissionName })
  .then((permission) => {
    if (!status) return;

    if (permission.state === 'granted') {
      status.textContent =
        'Microphone is already enabled. You can close this tab and return to Access OS.';
    } else if (permission.state === 'denied') {
      status.textContent = BLOCKED_MESSAGE;
    }
  })
  .catch((error) => console.error(error));

button?.addEventListener('click', async () => {
  if (!status) return;

  status.textContent = 'Requesting microphone access...';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });

    // only needed the prompt, release the mic right away
    stream.getTracks().forEach((track) => track.stop());

    status.textContent =
      'Microphone enabled! You can close this tab and return to Access OS.';
  } catch (error) {
    console.error(error);

    const name = error instanceof DOMException ? error.name : '';

    if (name === 'NotAllowedError') {
      status.textContent = BLOCKED_MESSAGE;
    } else if (name === 'NotFoundError') {
      status.textContent =
        'No microphone was found. Connect one and try again.';
    } else {
      status.textContent =
        'Microphone access failed. Please try again.';
    }
  }
});
