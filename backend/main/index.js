const { Builder, By, Key, until } = require("selenium-webdriver");

async function run() {
  let driver = await new Builder().forBrowser("chrome").build();

  try {
    await driver.get("http://www.google.com");

    const searchBox = await driver.findElement(By.name("q"));

    await searchBox.sendKeys("US Visa Appointment Ghana", Key.RETURN);

    await driver.wait(until.titleContains("US Visa"), 100000);
  } finally {
    await driver.quit();
  }
}

run();

// Main App

async function prepareDriver() {
  let driver = await new Builder().forBrowser("chrome").build();
  await driver.get(PLATFORM_URL);
  return driver;
}

async function login(driver) {
  // EMAIL
  const emailInput = await driver.wait(
    until.elementLocated(By.css('input[formcontrolname="username"]')),
    15000,
  );

  await emailInput.clear();
  await emailInput.sendKeys(USER_EMAIL);

  // PASSWORD
  const passwordInput = await driver.wait(
    until.elementLocated(By.css('input[formcontrolname="password"]')),
    15000,
  );

  await passwordInput.clear();
  await passwordInput.sendKeys(USER_PASSWORD);

  console.log("Email and password filled.");
  console.log("Please solve the CAPTCHA and click SIGN IN manually.");

  // WAIT FOR LOGIN SUCCESS (dashboard signal)
  await driver.wait(
    until.urlContains("dashboard"), // adjust if needed
    5 * 60 * 1000, // 5 minutes
  );

  console.log("Dashboard detected. Login complete.");
}

async function goToPendingAppointment(driver) {
  const pendingBtn = await driver.wait(
    until.elementLocated(
      By.xpath(
        "//div[contains(@class,'create-taskbutton') and contains(., 'PENDING APPOINTMENT')]",
      ),
    ),
    20000,
  );

  await driver.wait(until.elementIsVisible(pendingBtn), 10000);
  await pendingBtn.click();

  // Wait for navigation or appointment wrapper
  await driver.wait(until.urlContains("/appointment"), 20000);

  console.log("Navigated to Book Appointment page.");
}

async function selectPickupPoint(driver, pickupName) {
  const pickupSelect = await driver.wait(
    until.elementLocated(By.css("mat-select")),
    20000,
  );

  await pickupSelect.click();

  const option = await driver.wait(
    until.elementLocated(
      By.xpath(`//mat-option//span[contains(., '${pickupName}')]`),
    ),
    10000,
  );

  await option.click();

  console.log(`Pickup point selected: ${pickupName}`);
}

async function selectFirstAvailableDate(driver) {
  const enabledDates = await driver.findElements(
    By.css("button.mat-calendar-body-cell:not(.mat-calendar-body-disabled)"),
  );

  if (enabledDates.length === 0) {
    return false;
  }

  await enabledDates[0].click();
  console.log("Selected first available date.");
  return true;
}

async function confirmApplicant(driver) {
  const checkbox = await driver.wait(
    until.elementLocated(By.css("input[type='checkbox']")),
    10000,
  );

  const isChecked = await checkbox.isSelected();
  if (!isChecked) {
    await checkbox.click();
  }

  console.log("Applicant confirmed.");
}

async function bookAppointment(driver) {
  console.log("Booking step reached (not executed yet).");
}

async function handleAppointmentFlow(driver) {
  await goToPendingAppointment(driver);
  await selectPickupPoint(driver, "Accra");

  const dateFound = await selectFirstAvailableDate(driver);
  if (!dateFound) {
    console.log("No dates available. Waiting strategy will be added later.");
    return;
  }

  await confirmApplicant(driver);
  await bookAppointment(driver);
}

async function main() {
  let driver = await prepareDriver();
  await login(driver);
  await handleAppointmentFlow(driver);
  console.log("Bot is now idle on dashboard. Browser will remain open.");

  // Keep NodeJS alive so Selenium does not close the browser
  await driver.wait(() => false, Infinity);
}

main();
