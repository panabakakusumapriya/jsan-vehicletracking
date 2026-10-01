/** Hotel stays the office books for drivers — see backend/src/models/HotelBooking.js. */

export type StayState = 'upcoming' | 'staying' | 'completed' | 'cancelled' | 'booked';
export type BookedVia = 'booking_com' | 'direct' | 'phone' | 'other';
export type RoomType = 'single' | 'double' | 'twin' | 'family' | 'other';
export type Payment = 'company_card' | 'driver_claims' | 'pay_at_hotel';

export interface BookingDriver {
  name: string;
  driverCode: string | null;
  phone: string | null;
  email: string | null;
  project: string | null;
  region: string | null;
  country: string | null;
  vehiclePlate: string | null;
}

export interface BookingHotel {
  hotelLocationId: string | null;
  name: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  category: string | null;
  lat: number | null;
  lon: number | null;
}

export interface BookingAttachment {
  _id: string;
  filename: string;
  contentType: string;
  bytes: number;
  uploadedAt: string;
}

export interface HotelBooking {
  _id: string;
  driverId: string;
  driver: BookingDriver;
  hotel: BookingHotel;
  checkIn: string;
  checkOut: string;
  nights: number;
  rooms: number;
  roomType: RoomType;
  breakfastIncluded: boolean;
  bookingReference: string | null;
  bookedVia: BookedVia;
  totalCost: number | null;
  currency: string | null;
  costPerNight: number | null;
  payment: Payment;
  notes: string | null;
  status: 'booked' | 'cancelled';
  stayState: StayState;
  cancelledAt: string | null;
  cancelledByName: string | null;
  attachments: BookingAttachment[];
  bookedByName: string | null;
  createdAt: string;
}

/** What the profile endpoint prefills the form with. */
export interface DriverProfile extends BookingDriver {
  _id: string;
  currency: string | null;
  perDiem: number | null;
}

export const BOOKED_VIA_LABEL: Record<BookedVia, string> = {
  booking_com: 'Booking.com',
  direct: 'Direct with hotel',
  phone: 'By phone',
  other: 'Other',
};

export const ROOM_TYPE_LABEL: Record<RoomType, string> = {
  single: 'Single',
  double: 'Double',
  twin: 'Twin',
  family: 'Family',
  other: 'Other',
};

export const PAYMENT_LABEL: Record<Payment, string> = {
  company_card: 'Company card',
  driver_claims: 'Driver pays & claims',
  pay_at_hotel: 'Pay at hotel',
};

export const STAY_LABEL: Record<StayState, { text: string; tone: string }> = {
  upcoming: { text: 'Upcoming', tone: 'gray' },
  staying: { text: 'Staying now', tone: 'green' },
  completed: { text: 'Completed', tone: 'gray' },
  cancelled: { text: 'Cancelled', tone: 'red' },
  booked: { text: 'Booked', tone: 'gray' },
};

/** Today as a calendar day in the VIEWER's zone — the server files current/upcoming/past by it. */
export function todayIso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whole nights between two 'YYYY-MM-DD' days; null when either is missing or out of order. */
export function nightsBetween(checkIn: string, checkOut: string): number | null {
  if (!checkIn || !checkOut) return null;
  const n = Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "Thu 3 Oct" — a stay is read in days, so no year unless it is not this one. */
export function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function money(amount: number | null, currency: string | null): string {
  if (amount === null || amount === undefined) return '—';
  try {
    if (currency) return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  } catch { /* not an ISO code — fall through to plain */ }
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ''}`;
}
