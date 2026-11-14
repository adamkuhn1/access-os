
const button = document.querySelector<HTMLButtonElement>(
  '#allow-mic'
);

const status = document.querySelector<HTMLElement>('#status');

button?.addEventListener('click', async () => {
  if (!status) return;

  status.textContent = 'Requesting microphone access...';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });

    // Permission granted. Stop recording immediately.
    stream.getTracks().forEach((track) => track.stop());

    status.textContent =
      'Microphone enabled! Return to Access OS and try Speak.';
  } catch (error) {
    console.error(error);
    status.textContent =
      'Microphone access failed. Check Chrome permissions.';
  }
});
