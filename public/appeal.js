document.addEventListener('DOMContentLoaded', async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');

    const loadingState = document.getElementById('loading-state');
    const errorState = document.getElementById('error-state');
    const formState = document.getElementById('form-state');
    const successState = document.getElementById('success-state');

    const errorMessage = document.getElementById('error-message');
    const suspendReason = document.getElementById('suspend-reason');
    const suspendDate = document.getElementById('suspend-date');
    const suspendDuration = document.getElementById('suspend-duration');

    if (!token) {
        loadingState.classList.add('hidden');
        errorState.classList.remove('hidden');
        errorMessage.textContent = 'No security token provided in the URL.';
        return;
    }

    try {
        // Verify token with backend
        const response = await fetch(`/api/public/appeals/verify?token=${token}`);
        const data = await response.json();

        loadingState.classList.add('hidden');

        if (!response.ok) {
            errorState.classList.remove('hidden');
            errorMessage.textContent = data.error || 'Invalid or expired appeal link.';
            return;
        }

        // Show form and populate data
        formState.classList.remove('hidden');
        suspendReason.textContent = data.data.reason;
        suspendDate.textContent = new Date(data.data.suspended_at).toLocaleDateString();
        suspendDuration.textContent = data.data.duration_days ? `${data.data.duration_days} days` : 'Permanent';

    } catch (err) {
        loadingState.classList.add('hidden');
        errorState.classList.remove('hidden');
        errorMessage.textContent = 'A network error occurred. Please try again later.';
    }

    // Handle form submission
    document.getElementById('appeal-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = document.getElementById('submit-btn');
        const reasonText = document.getElementById('reason').value;

        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting...';

        try {
            const response = await fetch('/api/public/appeals/submit', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    token: token,
                    appealReason: reasonText
                })
            });

            const data = await response.json();

            if (!response.ok) {
                alert(data.error || 'Failed to submit appeal');
                submitBtn.disabled = false;
                submitBtn.textContent = 'Submit Appeal';
                return;
            }

            formState.classList.add('hidden');
            successState.classList.remove('hidden');

        } catch (err) {
            alert('Network error. Please try again.');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit Appeal';
        }
    });
});
