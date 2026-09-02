import mongoose, { Schema, Document } from "mongoose";

export interface IOrderItem {
  product: mongoose.Types.ObjectId;
  name: string;
  quantity: number;
  price: number;
  image: string;
}

export interface IShippingAddress {
  fullName: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string;
}

export interface IOrder extends Document {
  orderItems: IOrderItem[];
  shippingAddress: IShippingAddress;
  paymentMethod: "cash_on_delivery" | "paypal";
  paymentGateway?: "paypal";
  paypalOrderId?: string;
  paymentTransactionId?: string;
  paymentStatus?: "Created" | "Pending" | "Completed" | "Failed" | "Cancelled";
  itemsPrice: number;
  shippingPrice: number;
  taxPrice: number;
  totalPrice: number;
  user: {
    id?: string;
    name: string;
    email: string;
  };
  isPaid: boolean;
  paidAt?: Date;
  isDelivered: boolean;
  deliveredAt?: Date;
  status: "pending" | "processing" | "shipped" | "delivered" | "cancelled";
  stockRestored: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const OrderSchema: Schema = new Schema(
  {
    orderItems: [
      {
        product: {
          type: Schema.Types.ObjectId,
          ref: "Product",
          required: true,
        },
        name: { type: String, required: true },
        quantity: { type: Number, required: true, min: 1 },
        price: { type: Number, required: true, min: 0 },
        image: { type: String, required: true },
      },
    ],
    shippingAddress: {
      fullName: { type: String, required: true },
      address: { type: String, required: true },
      city: { type: String, required: true },
      state: { type: String, required: true },
      postalCode: { type: String, required: true },
      country: { type: String, required: true },
      phone: { type: String, required: true },
    },
    paymentMethod: {
      type: String,
      enum: ["cash_on_delivery", "paypal"],
      required: true,
      default: "cash_on_delivery",
    },
    paymentGateway: { type: String, enum: ["paypal"] },
    paypalOrderId: { type: String, index: true, sparse: true, unique: true },
    paymentTransactionId: { type: String, index: true, sparse: true },
    paymentStatus: {
      type: String,
      enum: ["Created", "Pending", "Completed", "Failed", "Cancelled"],
    },
    itemsPrice: { type: Number, required: true, min: 0 },
    shippingPrice: { type: Number, required: true, min: 0 },
    taxPrice: { type: Number, required: true, min: 0 },
    totalPrice: { type: Number, required: true, min: 0 },
    user: {
      id: { type: String },
      name: { type: String, required: true },
      email: { type: String, required: true, index: true },
    },
    isPaid: { type: Boolean, default: false },
    paidAt: { type: Date },
    isDelivered: { type: Boolean, default: false },
    deliveredAt: { type: Date },
    status: {
      type: String,
      enum: ["pending", "processing", "shipped", "delivered", "cancelled"],
      default: "pending",
    },
    stockRestored: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export default mongoose.model<IOrder>("Order", OrderSchema);
