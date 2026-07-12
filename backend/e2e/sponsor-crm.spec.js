const { test, expect } = require('@playwright/test');

test('operators manage sponsors, contacts and booking history in deployed fallback portal', async ({ page }) => {
  const organizations=[],contacts=[],bookings=[],history={};
  await page.route('**/api/sponsor-crm/**', async route => {
    const url=new URL(route.request().url()), parts=url.pathname.split('/').filter(Boolean), resource=parts[2], id=parts[3], action=parts[4], method=route.request().method(), body=route.request().postDataJSON?.()||{};
    const store=resource==='organizations'?organizations:resource==='contacts'?contacts:bookings;
    if(method==='GET'&&action==='history') return route.fulfill({json:{items:history[id]||[]}});
    if(method==='GET'&&!id) return route.fulfill({json:{items:store,nextCursor:null}});
    if(method==='POST'&&!id){const item={id:`${resource}-${store.length+1}`,version:1,createdAt:'2026-07-01T00:00:00Z',updatedAt:'2026-07-01T00:00:00Z',...body};store.push(item);if(resource==='bookings')history[item.id]=[{id:'history-1',actorId:'synthetic-operator',oldStatus:null,newStatus:item.status,note:'Booking created',createdAt:'2026-07-01T00:00:00Z'}];return route.fulfill({status:201,json:item});}
    if(method==='PUT'&&resource==='bookings'){if(body.scheduleEntryId==='conflict-slot')return route.fulfill({status:409,json:{error:'Schedule entry is already linked'}});const item=store.find(value=>value.id===id),old=item.status;Object.assign(item,body,{version:item.version+1,updatedAt:'2026-07-02T00:00:00Z'});if(body.status&&body.status!==old)history[id].push({id:'history-2',actorId:'synthetic-operator',oldStatus:old,newStatus:body.status,note:body.historyNote,createdAt:'2026-07-02T00:00:00Z'});return route.fulfill({json:item});}
    if(method==='DELETE'&&resource==='organizations'){const item=store.find(value=>value.id===id);Object.assign(item,{archivedAt:'2026-07-03T00:00:00Z',active:false,version:item.version+1});return route.fulfill({json:item});}
    return route.fulfill({status:404,json:{error:'Synthetic route not configured'}});
  });
  await page.goto('/#/sponsors');
  await expect(page.getByText('No sponsors found')).toBeVisible();
  await expect(page.getByText('No bookings',{exact:true})).toBeVisible();
  await page.screenshot({path:'.tmp/sponsor-crm-empty.png',fullPage:true});

  await page.getByRole('button',{name:'Add sponsor'}).click();
  const orgDialog=page.locator('#crm-org-dialog');await orgDialog.getByLabel('Name').fill('Synthetic Sponsor');await orgDialog.getByLabel('Private notes').fill('Private synthetic operator note');await orgDialog.getByRole('button',{name:'Save sponsor'}).click();await expect(page.locator('#crm-organizations')).toContainText('Synthetic Sponsor');
  await page.getByRole('button',{name:'Add contact'}).click();const contactDialog=page.locator('#crm-contact-dialog');await contactDialog.getByLabel('Name').fill('Synthetic Contact');await contactDialog.getByLabel('Email').fill('operator@example.invalid');await contactDialog.getByLabel('Primary contact').check();await contactDialog.getByRole('button',{name:'Save contact'}).click();
  await page.getByRole('button',{name:'Add booking'}).click();const bookingDialog=page.locator('#crm-booking-dialog');await bookingDialog.locator('select[name="status"]').selectOption('inquiry');await bookingDialog.getByLabel('Publication date').fill('2026-08-20');await bookingDialog.getByLabel('Material deadline').fill('2026-08-10');await bookingDialog.getByLabel('Next action').fill('2026-08-01');await bookingDialog.getByRole('button',{name:'Save booking'}).click();await expect(page.locator('#crm-bookings')).toContainText('inquiry');
  await page.getByRole('button',{name:'Edit'}).click();await bookingDialog.locator('select[name="status"]').selectOption('confirmed');await bookingDialog.getByLabel('Status note').fill('Synthetic confirmation');await bookingDialog.getByRole('button',{name:'Save booking'}).click();await expect(page.locator('#crm-bookings')).toContainText('confirmed');await page.getByRole('button',{name:'Open booking'}).click();await expect(page.locator('#crm-detail')).toContainText('inquiry → confirmed');await expect(page.locator('#crm-detail')).toContainText('Synthetic confirmation');await page.screenshot({path:'.tmp/sponsor-crm-populated-history.png',fullPage:true});

  await page.getByRole('button',{name:'Edit'}).click();await bookingDialog.getByLabel('Schedule entry ID').fill('conflict-slot');await bookingDialog.getByRole('button',{name:'Save booking'}).click();await expect(bookingDialog.getByRole('alert')).toContainText('Booking conflict');await bookingDialog.screenshot({path:'.tmp/sponsor-crm-conflict.png'});await bookingDialog.getByRole('button',{name:'Cancel'}).click();
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Archive'}).click();await page.getByLabel('Show').selectOption('false');await expect(page.locator('#crm-organizations')).toContainText('Archived');
  await page.setViewportSize({width:390,height:844});const mobile=await page.evaluate(()=>({columns:getComputedStyle(document.querySelector('.crm-grid')).gridTemplateColumns,page:document.documentElement.scrollWidth,viewport:document.documentElement.clientWidth}));expect(mobile.columns.trim().split(/\s+/)).toHaveLength(1);expect(mobile.page).toBeLessThanOrEqual(390);await page.screenshot({path:'.tmp/sponsor-crm-mobile.png',fullPage:true});
});
