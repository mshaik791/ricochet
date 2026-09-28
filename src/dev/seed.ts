import type { FakeVinAdapter } from "../adapters/vin/fake.js";
import type { Store } from "../store/types.js";

/** Local dev only: a rep, a contact and an assigned lead so simulate-event has something to hit. */
export async function seedDev(vin: FakeVinAdapter, store: Store, dealerId = "14011") {
  vin.dealers.set(dealerId, { id: dealerId, name: "Dublin Mazda", timezone: "America/Los_Angeles" });
  vin.users.set("501", { id: "501", dealerId, firstName: "Sam", lastName: "Rivera", email: "sam@example.com", phone: "+19255550101" });
  vin.contacts.set("9001", { id: "9001", dealerId, firstName: "Jordan", lastName: "Lee", emails: ["jordan.lee@example.com"], phones: ["+19255550142"], smsConsent: "unknown", emailOptOut: false });
  vin.leads.set("77001", {
    id: "77001", dealerId, contactId: "9001", repId: "501", source: "Dealer Website", createdAt: new Date(), status: "Active", tcpaOptIn: false,
    vehicles: [{ year: 2024, make: "Mazda", model: "CX-5", trim: "Premium", stockNumber: "M24187", isInventory: true, listedPrice: 33450 }],
  });
  vin.inventory.push({ stockNumber: "M24187", year: 2024, make: "Mazda", model: "CX-5", trim: "Premium", status: "In Stock", listedPrice: 33450, available: true });
  await store.upsertRep({ id: "501", dealerId, firstName: "Sam", lastName: "Rivera", email: "sam@example.com", phone: "+19255550101", smsFrom: "+19255550100" });
}
