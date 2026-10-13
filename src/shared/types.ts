// Snapshot shapes frozen onto documents at finalize time (documents.client_snapshot / seller_snapshot).

export interface ClientSnapshot {
  clientId: number;
  number: number;
  type: "company" | "person";
  name: string;
  contactPerson: string;
  street: string;
  addressExtra: string;
  zip: string;
  city: string;
  country: string;
  uid: string;
  email: string;
}

export interface SellerSnapshot {
  companyName: string;
  ownerName: string;
  street: string;
  zip: string;
  city: string;
  country: string;
  uid: string;
  taxNumber: string;
  companyRegister: string;
  email: string;
  phone: string;
  website: string;
  iban: string;
  bic: string;
  bankName: string;
  logoPath: string | null;
}
