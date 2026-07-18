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
    avatar: row.avatar,
    branch: row.branch
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
    createdAt: row.created_at,
    paymentMethod: row.payment_method || ''
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

// 0. Login Endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  // Static logins mapping
  const users = {
    'admin': { password: 'admin', role: 'owner', barberId: null, name: 'Dükkan Sahibi' },
    'izzethan': { password: 'izzethan123', role: 'barber', barberId: 1, name: 'İzzethan Çiftçi' },
    'turgut': { password: 'turgut123', role: 'barber', barberId: 2, name: 'Turgut Akhan' },
    'berathan': { password: 'berathan123', role: 'barber', barberId: 3, name: 'Berathan Çiftçi' }
  };

  const user = users[username?.toLowerCase()];
  if (user && user.password === password) {
    return res.json({
      success: true,
      user: {
        username,
        role: user.role,
        barberId: user.barberId,
        name: user.name
      }
    });
  }

  res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
});

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

  // Work hours from 10:00 to 21:00 (30 minute intervals)
  const allSlots = [
    '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', 
    '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', 
    '18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00'
  ];


  try {
    // Filter active (non-cancelled, non-no-show) appointments for the selected barber and date
    const result = await pool.query(
      `SELECT appointment_time FROM appointments 
       WHERE barber_id = $1 AND appointment_date = $2 AND status NOT IN ('İptal Edildi', 'Tamamlanmadı')`,
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
    // Verify date is not a Sunday (0 = Sunday)
    const dateParts = date.split('-');
    if (dateParts.length === 3) {
      const year = parseInt(dateParts[0], 10);
      const month = parseInt(dateParts[1], 10) - 1; 
      const day = parseInt(dateParts[2], 10);
      const parsedDate = new Date(year, month, day);
      if (parsedDate.getDay() === 0) {
        return res.status(400).json({ error: 'Pazar günleri dükkanımız kapalıdır.' });
      }
    }

    // Verify that the customer doesn't already have an active (Beklemede or Onaylandı) appointment
    const activeCheck = await pool.query(
      `SELECT COUNT(*) FROM appointments 
       WHERE customer_phone = $1 AND status IN ('Beklemede', 'Onaylandı')`,
      [customerPhone]
    );

    if (parseInt(activeCheck.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Mevcut bekleyen veya onaylanmış bir randevunuz zaten bulunmaktadır. Yeni randevu alabilmek için onun tamamlanmasını beklemelisiniz.' });
    }

    // Check if slot is already booked for this barber (exclude cancelled/no-shows)
    const checkRes = await pool.query(
      `SELECT COUNT(*) FROM appointments 
       WHERE barber_id = $1 AND appointment_date = $2 AND appointment_time = $3 AND status NOT IN ('İptal Edildi', 'Tamamlanmadı')`,
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
  const { status, paymentMethod } = req.body;

  if (!status || !['Onaylandı', 'İptal Edildi', 'Beklemede', 'Tamamlandı', 'Veresiye', 'Tamamlanmadı'].includes(status)) {
    return res.status(400).json({ error: 'Geçersiz randevu durumu.' });
  }

  try {
    let result;
    if (status === 'Tamamlandı') {
      result = await pool.query(
        'UPDATE appointments SET status = $1, payment_method = $2 WHERE id = $3 RETURNING *',
        [status, paymentMethod || 'Nakit', id]
      );
    } else {
      result = await pool.query(
        'UPDATE appointments SET status = $1 WHERE id = $2 RETURNING *',
        [status, id]
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Randevu bulunamadı.' });
    }

    res.json({ success: true, appointment: mapAppointment(result.rows[0]) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Randevu durumu güncellenirken hata oluştu.' });
  }
});

// 6.5 Pay Veresiye Debt (FIFO Partial payment)
app.post('/api/appointments/pay-debt', async (req, res) => {
  const { customerPhone, amount, paymentMethod } = req.body;
  if (!customerPhone || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Geçersiz parametreler.' });
  }

  let remainingAmount = parseInt(amount);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get all active Veresiye appointments for this customer phone, sorted oldest first
    const result = await client.query(
      `SELECT * FROM appointments 
       WHERE customer_phone = $1 AND status = 'Veresiye' 
       ORDER BY created_at ASC`,
      [customerPhone]
    );

    const veresiyes = result.rows;
    if (veresiyes.length === 0) {
      throw new Error('Bu müşteriye ait aktif veresiye kaydı bulunamadı.');
    }

    for (const app of veresiyes) {
      if (remainingAmount <= 0) break;

      if (app.total_price <= remainingAmount) {
        // Fully paid off
        remainingAmount -= app.total_price;
        await client.query(
          `UPDATE appointments 
           SET status = 'Tamamlandı', payment_method = $1 
           WHERE id = $2`,
          [paymentMethod || 'Nakit', app.id]
        );
      } else {
        // Partial payment - split the appointment!
        const newPrice = app.total_price - remainingAmount;
        const paidAmount = remainingAmount;
        remainingAmount = 0;

        // 1. Update original appointment with remaining debt
        await client.query(
          `UPDATE appointments 
           SET total_price = $1 
           WHERE id = $2`,
          [newPrice, app.id]
        );

        // 2. Insert a new completed appointment representing the partial payment amount
        const newId = Date.now().toString() + '_split';
        const createdAt = new Date().toISOString();
        await client.query(
          `INSERT INTO appointments (
            id, barber_id, barber_name, services, appointment_date, appointment_time, 
            customer_name, customer_phone, customer_email, notes, total_price, total_duration, 
            status, created_at, payment_method
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            newId, app.barber_id, app.barber_name, app.services, app.appointment_date, app.appointment_time,
            app.customer_name, app.customer_phone, app.customer_email || '', 
            (app.notes || '') + ` (Kısmi Tahsilat: ${paidAmount} TL)`, 
            paidAmount, app.total_duration, 'Tamamlandı', createdAt, paymentMethod || 'Nakit'
          ]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message || 'Tahsilat gerçekleştirilemedi.' });
  } finally {
    client.release();
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
