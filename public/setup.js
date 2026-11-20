const form = document.getElementById("bootstrapForm");
const notice = document.getElementById("notice");
const submit = document.getElementById("submitBootstrap");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submit.disabled = true;
  notice.textContent = "در حال ایجاد مدیر اولیه...";
  try {
    const response = await fetch("/api/admin/bootstrap", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bootstrap-key": document.getElementById("bootstrapKey").value
      },
      body: JSON.stringify({
        fullName: document.getElementById("fullName").value.trim(),
        guardianCode: document.getElementById("guardianCode").value,
        personCode: document.getElementById("personCode").value
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || "راه‌اندازی انجام نشد. اطلاعات و کلید را بررسی کنید.");
    }
    form.reset();
    notice.textContent = "مدیر اصلی با موفقیت ساخته شد. اکنون به صفحه ورود بازگردید و با اطلاعاتی که تعیین کردید وارد شوید.";
    submit.textContent = "مدیر ساخته شد";
    setTimeout(() => { window.location.href = "/"; }, 2500);
  } catch (error) {
    notice.textContent = error.message || "ارتباط با سرور برقرار نشد.";
    submit.disabled = false;
  }
});
