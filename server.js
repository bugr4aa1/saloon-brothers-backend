import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import pool, { initDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 5001;

// Create HTTP server to share with WebSockets
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

// WebSocket Connection Management
const activeAdminConnections = new Set();

wss.on('connection', (ws) => {
  console.log('Admin WebSocket client connected');
  activeAdminConnections.add(ws);

  ws.on('close', () => {
    console.log('Admin WebSocket client disconnected');
    activeAdminConnections.delete(ws);
  });
});

// Broadcast Helper
function broadcastToAdmins(payload) {
  const messageStr = JSON.stringify(payload);
  for (const client of activeAdminConnections) {
    if (client.readyState === 1) { // OPEN state
      try {
        client.send(messageStr);
      } catch (err) {
        console.error('Error broadcasting WebSocket message:', err);
      }
    }
  }
}

// Mapper Helpers
function mapBarber(row) {
  return {
    id: row.id,
    name: row.name,
    specialty: row.specialty,
    rating: parseFloat(row.rating),
    reviewCount: row.review_count,
    experience: row.experience,
    avatar: row.avatar
  };
}

function mapService(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: row.price,
    duration: row.duration
  };
}

function mapAppointment(row) {
  return {
    id: row.id,
    barberId: row.barber_id,
    barberName: row.barber_name,
    services: row.services,
    date: row.appointment_date,
    time: row.appointment_time,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerEmail: row.customer_email || '',
    notes: row.notes || '',
    totalPrice: row.total_price,
    totalDuration: row.total_duration,
    status: row.status,
    createdAt: row.created_at
  };
}

function mapExpense(row) {
  return {
    id: row.id,
    title: row.title,
    amount: row.amount,
    category: row.category,
    date: row.expense_date,
    notes: row.notes || '',
    createdAt: row.created_at
  };
}

// API Endpoints

// 1. Get Barbers
app.get('/api/barbers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM barbers ORDER BY id ASC');
    res.json(result.rows.map(mapBarber));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Berberler alınırken hata oluştu.' });
  }
});

// 2. Get Services
app.get('/api/services', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM services ORDER BY id ASC');
    res.json(result.rows.map(mapService));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Hizmetler alınırken hata oluştu.' });
  }
});

// 3. Get Slots for a specific barber and date
app.get('/api/slots', async (req, res) => {
  const { barberId, date } = req.query;

  if (!barberId || !date) {
    return res.status(400).json({ error: 'barberId ve date parametreleri zorunludur.' });
  }

  // Work hours from 09:00 to 20:00
  const allSlots = [
    '09:00', '10:00', '11:00', '12:00', '13:00', 
    '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'
  ];

  try {
    // Filter active (non-cancelled) appointments for the selected barber and date
    const result = await pool.query(
      `SELECT appointment_time FROM appointments 
       WHERE barber_id = $1 AND appointment_date = $2 AND status != 'İptal Edildi'`,
      [parseInt(barberId), date]
    );

    const bookedTimes = result.rows.map(r => r.appointment_time);

    // Format slots with status
    const formattedSlots = allSlots.map(time => ({
      time,
      isAvailable: !bookedTimes.includes(time)
    }));

    res.json(formattedSlots);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Saat dilimleri alınırken bir hata oluştu.' });
  }
});

// 4. Create a new appointment
app.post('/api/appointments', async (req, res) => {
  const { barberId, services, date, time, customerName, customerPhone, customerEmail, notes } = req.body;

  if (!barberId || !services || !services.length || !date || !time || !customerName || !customerPhone) {
    return res.status(400).json({ error: 'Lütfen zorunlu alanları doldurun.' });
  }

  try {
    // Check if slot is already booked for this barber (exclude cancelled ones)
    const checkRes = await pool.query(
      `SELECT COUNT(*) FROM appointments 
       WHERE barber_id = $1 AND appointment_date = $2 AND appointment_time = $3 AND status != 'İptal Edildi'`,
      [parseInt(barberId), date, time]
    );

    if (parseInt(checkRes.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Seçilen saat dilimi zaten dolu.' });
    }

    // Resolve barber
    const barberRes = await pool.query('SELECT * FROM barbers WHERE id = $1', [parseInt(barberId)]);
    if (barberRes.rows.length === 0) {
      return res.status(404).json({ error: 'Berber bulunamadı.' });
    }
    const barber = barberRes.rows[0];

    // Resolve service names and prices
    const servicesRes = await pool.query('SELECT * FROM services WHERE id = ANY($1)', [services]);
    const selectedServices = servicesRes.rows.map(mapService);
    const totalPrice = selectedServices.reduce((sum, s) => sum + s.price, 0);
    const totalDuration = selectedServices.reduce((sum, s) => sum + s.duration, 0);

    const newId = Date.now().toString();
    const createdAt = new Date().toISOString();

    const insertRes = await pool.query(
      `INSERT INTO appointments (
        id, barber_id, barber_name, services, appointment_date, appointment_time, 
        customer_name, customer_phone, customer_email, notes, total_price, total_duration, 
        status, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        newId, parseInt(barberId), barber.name, JSON.stringify(selectedServices), date, time,
        customerName, customerPhone, customerEmail || '', notes || '', totalPrice, totalDuration,
        'Beklemede', createdAt
      ]
    );

    const newAppointment = mapAppointment(insertRes.rows[0]);

    // Notify admins via WebSocket about the new appointment
    broadcastToAdmins({
      type: 'NEW_APPOINTMENT',
      appointment: newAppointment
    });

    res.status(201).json({ success: true, appointment: newAppointment });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Randevu oluşturulurken bir hata oluştu.' });
  }
});

// 5. Get all appointments
app.get('/api/appointments', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM appointments ORDER BY created_at DESC');
    res.json(result.rows.map(mapAppointment));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Randevular alınırken hata oluştu.' });
  }
});

// 6. Update appointment status (Onaylandı, İptal Edildi, Beklemede, Tamamlandı, Veresiye, Tamamlanmadı)
app.patch('/api/appointments/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status || !['Onaylandı', 'İptal Edildi', 'Beklemede', 'Tamamlandı', 'Veresiye', 'Tamamlanmadı'].includes(status)) {
    return res.status(400).json({ error: 'Geçersiz randevu durumu.' });
  }


  try {
    const result = await pool.query(
      'UPDATE appointments SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Randevu bulunamadı.' });
    }

    res.json({ success: true, appointment: mapAppointment(result.rows[0]) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Randevu durumu güncellenirken hata oluştu.' });
  }
});

// 7. Delete appointment
app.delete('/api/appointments/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM appointments WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Randevu bulunamadı.' });
    }

    res.json({ success: true, message: 'Randevu başarıyla silindi.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Randevu silinirken bir hata oluştu.' });
  }
});

// 8. Get all expenses
app.get('/api/expenses', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM expenses ORDER BY expense_date DESC, created_at DESC');
    res.json(result.rows.map(mapExpense));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Giderler alınırken hata oluştu.' });
  }
});

// 9. Create a new expense
app.post('/api/expenses', async (req, res) => {
  const { title, amount, category, date, notes } = req.body;

  if (!title || !amount || !category || !date) {
    return res.status(400).json({ error: 'Lütfen zorunlu alanları doldurun.' });
  }

  try {
    const newId = Date.now().toString();
    const createdAt = new Date().toISOString();

    const result = await pool.query(
      `INSERT INTO expenses (id, title, amount, category, expense_date, notes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [newId, title, parseInt(amount), category, date, notes || '', createdAt]
    );

    res.status(201).json({ success: true, expense: mapExpense(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gider eklenirken bir hata oluştu.' });
  }
});

// 10. Delete an expense
app.delete('/api/expenses/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM expenses WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gider bulunamadı.' });
    }

    res.json({ success: true, message: 'Gider başarıyla silindi.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gider silinirken bir hata oluştu.' });
  }
});

// Init DB and Start Server
async function start() {
  try {
    await initDb();
    server.listen(PORT, () => {
      console.log(`Server with PostgreSQL & WebSockets is running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
